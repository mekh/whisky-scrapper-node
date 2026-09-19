import { chromium } from 'playwright';

import {
  ACCEPT_LANGUAGE_LIST,
  CHROME_ARCHITECTURE,
  CHROME_BITNESS,
  CHROME_FULL_VERSION,
  CHROME_GREASE_BRAND,
  CHROME_MAJOR_VERSION,
  CHROME_NAVIGATOR_PLATFORM,
  CHROME_PLATFORM,
  CHROME_PLATFORM_VERSION,
  USER_AGENT,
} from '../http/headers.constants';
import { sleep } from '../scrape-timing.util';

import { isRequestAllowed } from './browser-request.policy';

import type { Browser, BrowserContext, Page, Route } from 'playwright';
import type {
  ChallengeOutcome,
  StealthContextOptions,
} from './browser.interfaces';

const CHALLENGE_TIMEOUT_MS = 45_000;
const CHALLENGE_POLL_MS = 1_500;
const CHALLENGE_MARKERS = ['зачека', 'moment'];

const WEBDRIVER_HIDE =
  "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});";

/**
 * Chromium switches on top of Playwright's own set.
 *
 * `--disable-blink-features=AutomationControlled` hides one of the things
 * Cloudflare's managed challenge checks for.
 *
 * `--disable-quic` keeps every connection on TCP. Chromium otherwise speaks
 * HTTP/3 over UDP 443 to any host that advertises it — measured 2026-09-05
 * against Rozetka's listing: the store's analytics endpoint and Google's
 * sign-in widget did, as UDP flows to Google addresses, on every page of the
 * walk. No other scraper of this service produces UDP traffic, and the
 * production host's firewall has no reason to expect it from the API
 * container; a request the policy in `browser-request.policy.ts` lets through
 * still has to travel the way the plain HTTP scrapers' requests do.
 */
const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-quic',
];

/**
 * The brands the client hints announce, in the order and with the GREASE entry
 * Chromium itself emits, matching the `Sec-Ch-Ua` header the HTTP tier sends.
 */
const CLIENT_HINT_BRANDS = [
  { brand: CHROME_GREASE_BRAND, version: '99' },
  { brand: 'Google Chrome', version: CHROME_MAJOR_VERSION },
  { brand: 'Chromium', version: CHROME_MAJOR_VERSION },
];

/**
 * The full user-agent metadata handed to Chromium's own override, which is the
 * only thing that reaches the Client Hints headers.
 */
const CLIENT_HINT_METADATA = {
  brands: CLIENT_HINT_BRANDS,
  fullVersionList: CLIENT_HINT_BRANDS.map(({ brand }) => ({
    brand,
    version: brand === CHROME_GREASE_BRAND ? '99.0.0.0' : CHROME_FULL_VERSION,
  })),
  fullVersion: CHROME_FULL_VERSION,
  platform: CHROME_PLATFORM,
  platformVersion: CHROME_PLATFORM_VERSION,
  architecture: CHROME_ARCHITECTURE,
  model: '',
  mobile: false,
  bitness: CHROME_BITNESS,
  wow64: false,
};

/**
 * Launches a headless Chromium with the automation-controlled flag disabled
 * and QUIC off — see {@link LAUNCH_ARGS}.
 *
 * @returns The launched browser.
 */
export function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: LAUNCH_ARGS,
  });
}

/**
 * Opens a stealth context: real-browser UA, Ukrainian locale/timezone, desktop
 * viewport, `navigator.webdriver` hidden, service workers blocked, and every
 * request routed through the browser request policy — the store's own hosts
 * and the Cloudflare challenge platform go through, everything else is
 * aborted before it reaches the network. The stealth half is ported from the
 * Python scraper's `_browser.py`; without it Cloudflare's managed challenge
 * never clears in headless mode.
 *
 * @param browser - A launched Chromium instance.
 * @param options - The store the context is scraping.
 * @returns The prepared context.
 */
export async function newStealthContext(
  browser: Browser,
  options: StealthContextOptions,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv',
    viewport: { width: 1366, height: 900 },
    /**
     * A service worker's fetches bypass `context.route()`, so a page that
     * registered one could reach hosts the policy never saw. The tiles are
     * server-rendered and the context lives for one page, so nothing is lost.
     */
    serviceWorkers: 'block',
  });

  await context.addInitScript(WEBDRIVER_HIDE);
  await context.route(
    '**/*',
    (route) => routeRequest(route, options.firstPartyHost),
  );

  return context;
}

/**
 * Replaces the page's Client Hints with ones consistent with its user agent.
 *
 * Playwright's `userAgent` option rewrites the UA string alone, so headless
 * Chromium keeps announcing itself as `HeadlessChrome` in `Sec-Ch-Ua` beside a
 * UA claiming Google Chrome — a contradiction Cloudflare's managed challenge
 * reads directly, on the main document and on every challenge request.
 *
 * @param context - The context the page belongs to.
 * @param page - The page to override, before it navigates anywhere.
 * @returns Resolves once the override is in force.
 */
export async function applyClientHints(
  context: BrowserContext,
  page: Page,
): Promise<void> {
  const session = await context.newCDPSession(page);

  await session.send('Emulation.setUserAgentOverride', {
    userAgent: USER_AGENT,
    acceptLanguage: ACCEPT_LANGUAGE_LIST,
    platform: CHROME_NAVIGATOR_PLATFORM,
    userAgentMetadata: CLIENT_HINT_METADATA,
  });
}

/**
 * Waits out a Cloudflare interstitial by polling the document title: the
 * challenge reloads the page itself once cleared, so a bare `waitForSelector`
 * on a fresh tab can miss the transition.
 *
 * @param page - The page being navigated.
 * @returns Whether the interstitial cleared, how long the wait took, and the
 *   titles seen while waiting.
 */
export async function awaitChallenge(page: Page): Promise<ChallengeOutcome> {
  const startedAt = Date.now();
  const deadline = startedAt + CHALLENGE_TIMEOUT_MS;
  const titles: string[] = [];

  while (Date.now() < deadline) {
    const title = (await page.title()).toLowerCase();

    if (titles[titles.length - 1] !== title) {
      titles.push(title);
    }

    const challenging = CHALLENGE_MARKERS.some(
      (marker) => title.includes(marker),
    );

    if (!challenging) {
      return { cleared: true, elapsedMs: Date.now() - startedAt, titles };
    }

    await sleep(CHALLENGE_POLL_MS);
  }

  return { cleared: false, elapsedMs: Date.now() - startedAt, titles };
}

/**
 * Lets one intercepted request through or aborts it, as the browser request
 * policy decides.
 *
 * @param route - The intercepted request's route.
 * @param firstPartyHost - The store's host.
 * @returns Resolves once the request has been continued or aborted.
 */
function routeRequest(route: Route, firstPartyHost: string): Promise<void> {
  const request = route.request();
  const allowed = isRequestAllowed(
    request.url(),
    request.resourceType(),
    firstPartyHost,
  );

  if (allowed) {
    return route.continue();
  }

  return route.abort('blockedbyclient');
}
