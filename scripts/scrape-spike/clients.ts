import { Impit } from 'impit';

import {
  applyClientHints,
  awaitChallenge,
  launchBrowser,
  newStealthContext,
} from '~scrape/browser/browser-context.factory';
import { firstPartyHostOf } from '~scrape/browser/browser-request.policy';
import { DEFAULT_HEADERS } from '~scrape/http/headers.constants';

import type { Page } from 'playwright';

import type {
  SpikeClient,
  SpikeClientKind,
  SpikeRequestOptions,
  SpikeResponse,
} from './spike.interfaces';

const REQUEST_TIMEOUT_MS = 30_000;
const NAVIGATION_TIMEOUT_MS = 60_000;
const SELECTOR_TIMEOUT_MS = 45_000;

/**
 * Substrings that only appear while a Cloudflare interstitial (JS challenge
 * or managed challenge) is being served instead of the real page.
 */
const CHALLENGE_MARKERS = [
  'just a moment',
  'трохи зачекайте',
  'зачекайте',
  'cf-browser-verification',
  'cf_chl_opt',
  '__cf_chl',
  'attention required!',
  'checking your browser',
];

/**
 * Appends query parameters to a URL, stringifying numbers.
 *
 * @param url - Absolute base URL, with or without an existing query string.
 * @param params - Parameters to append; skipped when empty or absent.
 * @returns The URL with the parameters applied.
 */
export const buildUrl = (
  url: string,
  params?: Record<string, string | number>,
): string => {
  if (!params) {
    return url;
  }

  const target = new URL(url);

  Object.entries(params).forEach(([key, value]) => {
    target.searchParams.set(key, String(value));
  });

  return target.toString();
};

/**
 * Detects a Cloudflare interstitial in a response body.
 *
 * @param body - Response body as text.
 * @returns True when the body looks like a challenge page, not real content.
 */
export const looksChallenged = (body: string): boolean => {
  const head = body.slice(0, 4_000).toLowerCase();

  return CHALLENGE_MARKERS.some((marker) => head.includes(marker));
};

/**
 * Sleeps for a fixed number of milliseconds.
 *
 * @param ms - How long to sleep.
 * @returns Resolves once the delay has elapsed.
 */
export const wait = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Draws a jittered delay from a store's configured range and sleeps for it.
 *
 * @param range - `[from, to]` delay bounds in seconds.
 * @returns Resolves once the delay has elapsed.
 */
export const politeSleep = (range: [number, number]): Promise<void> => {
  const [from, to] = range;
  const seconds = from + Math.random() * (to - from);

  return wait(seconds * 1_000);
};

/**
 * Collects a `Headers` object into a plain lower-cased record.
 *
 * @param headers - Fetch-style headers.
 * @returns Header name/value pairs.
 */
const collectHeaders = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};

  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });

  return out;
};

/**
 * Builds a client backed by Node's global `fetch` (undici) with a realistic
 * Chrome header set — the cheapest strategy, and the one whose TLS handshake
 * Cloudflare can fingerprint as non-browser.
 *
 * The headers are the scraper's own (`~scrape/http/headers.constants`) rather
 * than a copy: this spike is a canary for the fingerprint production actually
 * presents, and a local copy drifted two Chrome years behind it once already.
 *
 * @returns The plain-fetch client.
 */
const createPlainClient = (): SpikeClient => {
  return {
    get: async (
      url: string,
      options?: SpikeRequestOptions,
    ): Promise<SpikeResponse> => {
      const response = await fetch(buildUrl(url, options?.params), {
        headers: { ...DEFAULT_HEADERS, ...options?.headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      return {
        status: response.status,
        body: await response.text(),
        headers: collectHeaders(response.headers),
      };
    },
    close: async (): Promise<void> => {
      // Nothing to release: undici manages its own global agent.
    },
  };
};

/**
 * Builds a client backed by `impit` impersonating Chrome, which reproduces a
 * real browser's TLS/JA3 and HTTP/2 fingerprint. Only `Accept-Language` is
 * overridden — impersonation owns the rest of the headers, and desyncing them
 * is exactly what Cloudflare looks for.
 *
 * @returns The impit client.
 */
const createImpitClient = (): SpikeClient => {
  const impit = new Impit({
    browser: 'chrome',
    followRedirects: true,
    timeout: REQUEST_TIMEOUT_MS,
    headers: { 'Accept-Language': DEFAULT_HEADERS['Accept-Language'] },
  });

  return {
    get: async (
      url: string,
      options?: SpikeRequestOptions,
    ): Promise<SpikeResponse> => {
      const response = await impit.fetch(buildUrl(url, options?.params), {
        method: 'GET',
        headers: options?.headers,
      });

      return {
        status: response.status,
        body: await response.text(),
        headers: collectHeaders(response.headers),
      };
    },
    close: async (): Promise<void> => {
      // impit owns its connection pool and has no explicit teardown.
    },
  };
};

/**
 * Builds a browser-backed client. Every request runs in a freshly created
 * context, which is what lets Rozetka paginate at all: it blocks the second
 * and later navigations inside one context, while the first navigation of a
 * new context reliably clears the challenge.
 *
 * The launch flags, the stealth context, its request policy, the Client Hints
 * override and the challenge wait are the scraper's own, so what this canary
 * presents is what production presents — a spike that probes with a weaker
 * fingerprint than the real thing measures nothing useful.
 *
 * @param delayRange - Politeness delay range used after each render.
 * @returns The browser client, including the `evaluate` capability.
 */
const createBrowserClient = async (
  delayRange: [number, number],
): Promise<SpikeClient> => {
  const browser = await launchBrowser();

  const render = async <T>(
    url: string,
    waitSelector: string | undefined,
    extract: (page: Page) => Promise<T>,
  ): Promise<{ status: number; value: T }> => {
    const context = await newStealthContext(browser, {
      firstPartyHost: firstPartyHostOf(url),
    });
    const page = await context.newPage();

    try {
      await applyClientHints(context, page);

      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS,
      });

      /**
       * Concurrently, as production does: the interstitial carries none of the
       * store's markup, so the selector cannot appear before it clears.
       */
      await Promise.all([
        awaitChallenge(page),
        waitSelector
          ? page
            .waitForSelector(waitSelector, { timeout: SELECTOR_TIMEOUT_MS })
            .catch(() => null)
          : Promise.resolve(null),
      ]);

      await politeSleep(delayRange);

      return { status: response?.status() ?? 0, value: await extract(page) };
    } finally {
      await context.close();
    }
  };

  return {
    get: async (
      url: string,
      options?: SpikeRequestOptions,
    ): Promise<SpikeResponse> => {
      const rendered = await render(
        buildUrl(url, options?.params),
        undefined,
        (page) => page.content(),
      );

      return { status: rendered.status, body: rendered.value, headers: {} };
    },
    evaluate: async (
      url: string,
      script: string,
      waitSelector?: string,
    ): Promise<unknown> => {
      // Playwright's JS API evaluates a string as an expression and, unlike
      // its Python counterpart, never calls it — a bare `() => {...}` string
      // would silently yield undefined. Wrapping it in an IIFE is what makes
      // the extractor actually run.
      const rendered = await render(
        url,
        waitSelector,
        (page) => page.evaluate(`(${script})()`),
      );

      return rendered.value;
    },
    close: async (): Promise<void> => {
      await browser.close();
    },
  };
};

/**
 * Creates the client for a given strategy.
 *
 * @param kind - Which transport to build.
 * @param delayRange - Politeness delay range, used by the browser client.
 * @returns The ready-to-use client.
 */
export const createClient = (
  kind: SpikeClientKind,
  delayRange: [number, number],
): Promise<SpikeClient> => {
  if (kind === 'plain') {
    return Promise.resolve(createPlainClient());
  }

  if (kind === 'impit') {
    return Promise.resolve(createImpitClient());
  }

  return createBrowserClient(delayRange);
};
