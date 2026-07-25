import { ScrapeAdapterBase } from '../adapters/scrape-adapter.base';
import {
  awaitChallenge,
  launchBrowser,
  newStealthContext,
} from './browser-context.factory';

import type { Browser } from 'playwright';

const NAVIGATION_TIMEOUT_MS = 60_000;
const SELECTOR_TIMEOUT_MS = 35_000;

/**
 * Base for tier-3 (Cloudflare-guarded, browser-rendered) adapters. Launches
 * Chromium lazily and evaluates a DOM extractor in a fresh context per page —
 * the trick that lets Rozetka paginate at all, since it blocks the second and
 * later navigations inside one context while a new context's first navigation
 * clears the challenge.
 */
export abstract class BrowserAdapterBase extends ScrapeAdapterBase {
  private browser: Browser | null = null;

  /**
   * Closes the browser if it was launched.
   *
   * @returns Resolves once closed.
   */
  public async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();

      this.browser = null;
    }
  }

  /**
   * Navigates to a URL in a fresh stealth context and evaluates a DOM
   * extractor, returning whatever it produced.
   *
   * @param url - Absolute URL to open.
   * @param script - Arrow-function source (`() => {...}`); wrapped in an IIFE
   *   before evaluation, because Playwright's JS API does not call a function
   *   passed as a plain string.
   * @param waitSelector - Optional selector awaited before evaluating.
   * @returns The extractor's result.
   */
  protected async renderEval(
    url: string,
    script: string,
    waitSelector?: string,
  ): Promise<unknown> {
    const browser = await this.ensureBrowser();
    const context = await newStealthContext(browser);
    const page = await context.newPage();

    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS,
      });

      await awaitChallenge(page);

      if (waitSelector) {
        await page
          .waitForSelector(waitSelector, { timeout: SELECTOR_TIMEOUT_MS })
          .catch(() => null);
      }

      await this.sleep();

      return await page.evaluate(`(${script})()`);
    } finally {
      await context.close();
    }
  }

  /**
   * Launches the browser on first use and reuses it afterwards.
   *
   * @returns The shared browser instance.
   */
  private async ensureBrowser(): Promise<Browser> {
    this.browser ??= await launchBrowser();

    return this.browser;
  }
}
