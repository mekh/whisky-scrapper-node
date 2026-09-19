import type { Page, Response } from 'playwright';

/**
 * What a stealth context needs to know to keep the browser's traffic on the
 * store it is scraping.
 */
export interface StealthContextOptions {
  /**
   * Registrable host of the store being scraped (`rozetka.com.ua`). Requests
   * to it and to its subdomains are the only ones allowed out of the context,
   * besides the Cloudflare challenge platform — see
   * `browser-request.policy.ts`.
   */
  firstPartyHost: string;
}

/**
 * How a wait for the Cloudflare interstitial ended.
 */
export interface ChallengeOutcome {
  /**
   * Whether the interstitial was gone before the wait ran out. False means the
   * challenge never cleared, which is indistinguishable from a blocked page in
   * everything but this flag.
   */
  cleared: boolean;

  /**
   * How long the wait took, in milliseconds.
   */
  elapsedMs: number;

  /**
   * Every distinct document title seen while waiting, in order. It is what
   * names the page a stuck walk was actually looking at.
   */
  titles: string[];
}

/**
 * What one browser render did, beyond the value it produced. Collected on
 * every render and reported only when the page turned out to be unusable,
 * because nothing else can say why a page came back empty.
 */
export interface RenderDiagnostics {
  /**
   * HTTP status of the main document, or null when the navigation produced no
   * response. Cloudflare serves its interstitial as 403 and its rate limit as
   * 429, so this alone separates the two.
   */
  status: number | null;

  /**
   * The URL the page ended on, which differs from the requested one after a
   * redirect.
   */
  finalUrl: string;

  /**
   * The document title when the page was read.
   */
  title: string;

  /**
   * Cloudflare's ray id for the main document, or null when the response
   * carried none. It is what identifies this request in Cloudflare's own logs.
   */
  cfRay: string | null;

  /**
   * How the wait for the Cloudflare interstitial ended.
   */
  challenge: ChallengeOutcome;

  /**
   * Whether the awaited selector ever appeared, or null when the render
   * awaited none.
   */
  selectorFound: boolean | null;

  /**
   * The non-2xx responses the page received, newest last, as
   * `<status> <type> <url>`. Capped, since a blocked page can produce many.
   */
  errorResponses: string[];

  /**
   * The start of the page's rendered text, whitespace collapsed. A title is
   * often generic where the body names the refusal outright.
   */
  bodyExcerpt: string;

  /**
   * How long the whole render took, in milliseconds, the politeness delay
   * included.
   */
  elapsedMs: number;
}

/**
 * What {@link RenderDiagnostics} is assembled from: the page as it stands
 * after both waits, plus what those waits and the navigation produced.
 */
export interface RenderProbe {
  /**
   * The rendered page, still open.
   */
  page: Page;

  /**
   * The main document's response, or null when the navigation produced none.
   */
  response: Response | null;

  /**
   * How the wait for the Cloudflare interstitial ended.
   */
  challenge: ChallengeOutcome;

  /**
   * Whether the awaited selector appeared, or null when none was awaited.
   */
  selectorFound: boolean | null;

  /**
   * The non-2xx responses collected while the page loaded.
   */
  errorResponses: string[];

  /**
   * When the render started, as an epoch milliseconds stamp.
   */
  startedAt: number;
}

/**
 * A rendered page's value together with what the render observed.
 */
export interface RenderResult<T> {
  /**
   * Whatever the page's reader produced.
   */
  value: T;

  /**
   * What the render observed while producing it.
   */
  diagnostics: RenderDiagnostics;
}
