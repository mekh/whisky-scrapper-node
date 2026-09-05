import { chromium } from 'playwright';

import { USER_AGENT } from '../http/headers.constants';
import { sleep } from '../scrape-timing.util';

import { isRequestAllowed } from './browser-request.policy';

import type { Browser, BrowserContext, Page, Route } from 'playwright';
import type { StealthContextOptions } from './browser.interfaces';

const CHALLENGE_TIMEOUT_MS = 30_000;
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
 * Waits out a Cloudflare interstitial by polling the document title: the
 * challenge reloads the page itself once cleared, so a bare `waitForSelector`
 * on a fresh tab can miss the transition.
 *
 * @param page - The page being navigated.
 * @returns Resolves once the title no longer looks like an interstitial.
 */
export async function awaitChallenge(page: Page): Promise<void> {
  const deadline = Date.now() + CHALLENGE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const title = (await page.title()).toLowerCase();

    if (!CHALLENGE_MARKERS.some((marker) => title.includes(marker))) {
      return;
    }

    await sleep(CHALLENGE_POLL_MS);
  }
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
