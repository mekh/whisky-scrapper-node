import { ScrapeAdapterBase } from '../adapters/scrape-adapter.base';
import {
  applyClientHints,
  awaitChallenge,
  launchBrowser,
  newStealthContext,
} from './browser-context.factory';
import { firstPartyHostOf } from './browser-request.policy';

import type { Browser, Page, Response } from 'playwright';
import type {
  RenderDiagnostics,
  RenderProbe,
  RenderResult,
} from './browser.interfaces';

const NAVIGATION_TIMEOUT_MS = 60_000;
const SELECTOR_TIMEOUT_MS = 45_000;

const MAX_ERROR_RESPONSES = 8;
const BODY_EXCERPT_CHARS = 300;

const BODY_TEXT_JS = 'document.body '
  + '? (document.body.innerText || document.body.textContent || "") '
  + ': ""';

/**
 * Resource types whose failures are worth recording. Scripts are left out
 * because Rozetka proxies Google Analytics through its own origin and answers
 * 403 to every one of those on a perfectly good page.
 */
const DIAGNOSTIC_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  'document',
  'xhr',
  'fetch',
]);

/**
 * Base for tier-3 (Cloudflare-guarded, browser-rendered) adapters. Launches
 * Chromium lazily and evaluates a DOM extractor in a fresh context per page —
 * the trick that lets Rozetka paginate at all, since it blocks the second and
 * later navigations inside one context while a new context's first navigation
 * clears the challenge.
 *
 * Every context is confined to the store's own hosts (plus the Cloudflare
 * challenge platform) by the browser request policy, so the only traffic the
 * browser tier adds over a plain HTTP scraper is the store's own scripts.
 */
export abstract class BrowserAdapterBase extends ScrapeAdapterBase {
  /**
   * Waits for a selector, reporting whether it ever appeared rather than
   * throwing — a page that never rendered its content is a diagnosis, not an
   * exception.
   *
   * @param page - The page being read.
   * @param selector - The selector to await, or undefined to skip the wait.
   * @returns True when it appeared, false when the wait ran out, null when
   *   there was nothing to wait for.
   */
  private static awaitSelector(
    page: Page,
    selector: string | undefined,
  ): Promise<boolean | null> {
    if (selector === undefined) {
      return Promise.resolve(null);
    }

    return page
      .waitForSelector(selector, { timeout: SELECTOR_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
  }

  /**
   * Collects what the render observed, for the log line a failed page earns.
   *
   * @param probe - The page, its main response and both waits' outcomes.
   * @returns The diagnostics.
   */
  private static async describe(
    probe: RenderProbe,
  ): Promise<RenderDiagnostics> {
    const { page, response } = probe;
    const body = await page.evaluate(BODY_TEXT_JS).catch(() => '');
    const cfRay = response
      ? await response.headerValue('cf-ray').catch(() => null)
      : null;

    return {
      status: response ? response.status() : null,
      finalUrl: page.url(),
      title: await page.title().catch(() => ''),
      cfRay,
      challenge: probe.challenge,
      selectorFound: probe.selectorFound,
      errorResponses: probe.errorResponses,
      bodyExcerpt: String(body)
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, BODY_EXCERPT_CHARS),
      elapsedMs: Date.now() - probe.startedAt,
    };
  }

  /**
   * Appends one non-2xx response to the render's error list, up to the cap,
   * ignoring the resource types whose failures say nothing.
   *
   * @param into - The list collected for this render.
   * @param response - The response the page received.
   */
  private static recordErrorResponse(
    into: string[],
    response: Response,
  ): void {
    const status = response.status();
    const type = response.request().resourceType();

    if (status < 400 || into.length >= MAX_ERROR_RESPONSES) {
      return;
    }

    if (!DIAGNOSTIC_RESOURCE_TYPES.has(type)) {
      return;
    }

    into.push(`${status} ${type} ${response.url()}`);
  }

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
   * @returns The extractor's result and what the render observed.
   */
  protected renderEval(
    url: string,
    script: string,
    waitSelector?: string,
  ): Promise<RenderResult<unknown>> {
    return this.render(
      url,
      waitSelector,
      (page) => page.evaluate(`(${script})()`),
    );
  }

  /**
   * Navigates to a URL in a fresh stealth context and returns the rendered
   * HTML, for adapters that parse the DOM outside the browser.
   *
   * @param url - Absolute URL to open.
   * @param waitSelector - Optional selector awaited before reading the DOM.
   * @returns The page's HTML and what the render observed.
   */
  protected renderHtml(
    url: string,
    waitSelector?: string,
  ): Promise<RenderResult<string>> {
    return this.render(url, waitSelector, (page) => page.content());
  }

  /**
   * Closes the browser so the next render launches a fresh one, for a walk
   * whose pages keep coming back unusable. A context is already per page, so
   * the browser is the only state a retry could still be inheriting.
   *
   * @returns Resolves once the browser is closed.
   */
  protected restartBrowser(): Promise<void> {
    return this.close();
  }

  /**
   * Opens a page in a fresh stealth context, waits out the Cloudflare
   * challenge and the store's politeness delay, then reads it.
   *
   * The challenge wait and the selector wait run **concurrently**: the
   * interstitial carries none of the store's own markup, so the selector
   * cannot appear early, and waiting in series spent both timeouts on a page
   * that was failing either way.
   *
   * @param url - Absolute URL to open.
   * @param waitSelector - Optional selector awaited before reading.
   * @param read - Extracts the result from the rendered page.
   * @returns Whatever `read` produced, with what the render observed.
   */
  private async render<T>(
    url: string,
    waitSelector: string | undefined,
    read: (page: Page) => Promise<T>,
  ): Promise<RenderResult<T>> {
    const startedAt = Date.now();
    const browser = await this.ensureBrowser();
    const context = await newStealthContext(browser, {
      firstPartyHost: firstPartyHostOf(this.spec.baseUrl),
    });
    const errorResponses: string[] = [];

    context.on('response', (response) => {
      BrowserAdapterBase.recordErrorResponse(errorResponses, response);
    });

    const page = await context.newPage();

    try {
      await applyClientHints(context, page);

      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS,
      });

      const [challenge, selectorFound] = await Promise.all([
        awaitChallenge(page),
        BrowserAdapterBase.awaitSelector(page, waitSelector),
      ]);

      await this.sleep();

      const value = await read(page);
      const diagnostics = await BrowserAdapterBase.describe({
        page,
        response,
        challenge,
        selectorFound,
        errorResponses,
        startedAt,
      });

      return { value, diagnostics };
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
