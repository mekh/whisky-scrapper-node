import { chromium } from 'playwright';

import { USER_AGENT } from '../http/headers.constants';
import { sleep } from '../scrape-timing.util';

import type { Browser, BrowserContext, Page } from 'playwright';

const CHALLENGE_TIMEOUT_MS = 30_000;
const CHALLENGE_POLL_MS = 1_500;
const CHALLENGE_MARKERS = ['зачека', 'moment'];

const WEBDRIVER_HIDE =
  "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});";

/**
 * Launches a headless Chromium with the automation-controlled flag disabled —
 * one of the things Cloudflare's managed challenge checks for.
 *
 * @returns The launched browser.
 */
export function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

/**
 * Opens a stealth context: real-browser UA, Ukrainian locale/timezone, desktop
 * viewport, and `navigator.webdriver` hidden. Ported from the Python scraper's
 * `_browser.py`; without it Cloudflare's managed challenge never clears in
 * headless mode.
 *
 * @param browser - A launched Chromium instance.
 * @returns The prepared context.
 */
export async function newStealthContext(
  browser: Browser,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv',
    viewport: { width: 1366, height: 900 },
  });

  await context.addInitScript(WEBDRIVER_HIDE);

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
