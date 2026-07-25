/**
 * Which transport a spike run uses to reach a store: plain Node `fetch`,
 * `impit` (Chrome TLS/JA3 impersonation), or a real Chromium browser.
 */
export type SpikeClientKind = 'plain' | 'impit' | 'playwright';

/**
 * Per-request options accepted by every spike client.
 */
export interface SpikeRequestOptions {
  /**
   * Query-string parameters appended to the URL. Numbers are stringified.
   */
  params?: Record<string, string | number>;

  /**
   * Extra request headers merged over the client's own defaults.
   */
  headers?: Record<string, string>;
}

/**
 * Minimal response shape shared by every spike client.
 */
export interface SpikeResponse {
  /**
   * HTTP status of the response. Browser-backed clients report the status of
   * the main navigation request, or 0 when the navigation yielded no
   * response object.
   */
  status: number;

  /**
   * Response body as UTF-8 text. For browser-backed clients this is the
   * rendered DOM (`page.content()`), not the original payload.
   */
  body: string;

  /**
   * Lower-cased response headers. Empty for browser-backed clients when the
   * navigation response is unavailable.
   */
  headers: Record<string, string>;
}

/**
 * Everything a probe is allowed to use, so one probe body can run over any
 * client kind without knowing which one it got.
 */
export interface SpikeProbeContext {
  /**
   * Performs one GET request and returns the decoded response.
   *
   * @param url - Absolute URL to request.
   * @param options - Optional query parameters and extra headers.
   * @returns The decoded response.
   */
  get(url: string, options?: SpikeRequestOptions): Promise<SpikeResponse>;

  /**
   * Navigates to a URL in a real browser and evaluates a DOM extractor.
   * Present only for the `playwright` client; probes that require it must
   * declare `playwright` as their only supported client.
   *
   * @param url - Absolute URL to open.
   * @param script - Arrow-function source (`() => {...}`) that the client
   *   invokes in page context; Playwright's JS API does not call a function
   *   passed as a plain string, so the client wraps it itself.
   * @param waitSelector - Optional selector awaited before evaluating.
   * @returns Whatever the extractor returned, serialized by Playwright.
   */
  evaluate?(
    url: string,
    script: string,
    waitSelector?: string,
  ): Promise<unknown>;

  /**
   * Sleeps for a jittered delay drawn from the store's configured range —
   * the same politeness pacing the production scraper uses.
   *
   * @returns Resolves once the delay has elapsed.
   */
  sleep(): Promise<void>;

  /**
   * Writes one progress line to stdout, prefixed by the current run.
   *
   * @param message - Human-readable progress message.
   */
  log(message: string): void;
}

/**
 * A transport implementation the runner hands to probes, plus its teardown.
 */
export interface SpikeClient {
  /**
   * Performs one GET request and returns the decoded response.
   *
   * @param url - Absolute URL to request.
   * @param options - Optional query parameters and extra headers.
   * @returns The decoded response.
   */
  get(url: string, options?: SpikeRequestOptions): Promise<SpikeResponse>;

  /**
   * DOM-extractor entry point; only browser-backed clients provide it.
   *
   * @param url - Absolute URL to open.
   * @param script - Arrow-function source (`() => {...}`) that the client
   *   invokes in page context; Playwright's JS API does not call a function
   *   passed as a plain string, so the client wraps it itself.
   * @param waitSelector - Optional selector awaited before evaluating.
   * @returns Whatever the extractor returned.
   */
  evaluate?(
    url: string,
    script: string,
    waitSelector?: string,
  ): Promise<unknown>;

  /**
   * Releases the client's resources (sockets, browser process).
   *
   * @returns Resolves once everything is closed.
   */
  close(): Promise<void>;
}

/**
 * Outcome of a single probe pass (one walk over `pages` listing pages).
 */
export interface SpikeProbeResult {
  /**
   * How many listing pages were actually fetched before the probe stopped.
   */
  pages: number;

  /**
   * How many distinct sellable items were parsed across those pages.
   */
  items: number;

  /**
   * How many of `items` were reported as in stock by the store.
   */
  inStock: number;

  /**
   * HTTP statuses observed, in request order — the fingerprint-block signal
   * (403/429 here means the client was rejected).
   */
  statuses: number[];

  /**
   * True when any response body carried a Cloudflare interstitial marker.
   */
  challenged: boolean;

  /**
   * First parsed item rendered as `name | price | sku`, for eyeballing that
   * the parse produced real data rather than empty shells.
   */
  sample: string | null;
}

/**
 * One parsed listing entry, reduced to the fields the spike verifies.
 */
export interface SpikeItem {
  /**
   * Store-side identifier used to deduplicate across pages.
   */
  sku: string;

  /**
   * Product title as the store presents it.
   */
  name: string;

  /**
   * Current price in UAH, or null when the listing carried none (such an
   * entry is not counted as a parsed item).
   */
  price: number | null;

  /**
   * Whether the store reports the item as available.
   */
  inStock: boolean;
}

/**
 * What one listing page yielded.
 */
export interface SpikePage {
  /**
   * HTTP status of the page request.
   */
  status: number;

  /**
   * Raw response body, used for Cloudflare-interstitial detection. Null when
   * the page came from a DOM extractor rather than a body.
   */
  body: string | null;

  /**
   * Entries parsed from this page, before cross-page deduplication.
   */
  items: SpikeItem[];
}

/**
 * One store's spike probe: what it needs and how to run it.
 */
export interface SpikeProbe {
  /**
   * Store slug, matching the `store.slug` column in the database.
   */
  slug: string;

  /**
   * Politeness delay range in seconds, copied from `store_config`
   * (`delayFrom`/`delayTo`) so the spike paces itself like production.
   */
  delayRange: [number, number];

  /**
   * Client kinds this probe can run over. A single-entry list means the
   * probe cannot work any other way (for example a browser-only store).
   */
  supported: SpikeClientKind[];

  /**
   * Walks the store's listing and reports what was parsed.
   *
   * @param ctx - Client-backed context (fetch/evaluate/sleep/log).
   * @param pages - Maximum number of listing pages to fetch.
   * @returns Metrics for this pass.
   */
  run(ctx: SpikeProbeContext, pages: number): Promise<SpikeProbeResult>;
}

/**
 * Result of one attempt within a repeat/soak series.
 */
export interface SpikeAttempt {
  /**
   * 1-based attempt number within the series.
   */
  attempt: number;

  /**
   * True when the probe completed and parsed at least one item.
   */
  ok: boolean;

  /**
   * Wall-clock duration of the attempt in milliseconds.
   */
  durationMs: number;

  /**
   * Probe metrics; absent when the attempt threw before finishing.
   */
  result: SpikeProbeResult | null;

  /**
   * Error message when the attempt threw, otherwise null.
   */
  error: string | null;
}

/**
 * Parsed command-line arguments for the spike runner.
 */
export interface SpikeCliArgs {
  /**
   * Store slugs to probe, already expanded from `all` to the default plan.
   */
  stores: string[];

  /**
   * Client kind forced by the caller, or null to use each store's planned
   * client list (including the escalation chain).
   */
  client: SpikeClientKind | null;

  /**
   * Maximum listing pages fetched per attempt.
   */
  pages: number;

  /**
   * Number of attempts per store x client combination (quick pass).
   */
  repeat: number;

  /**
   * When above zero, keep repeating attempts for this many minutes instead of
   * stopping after `repeat` attempts (soak pass).
   */
  soakMinutes: number;

  /**
   * Path to write the JSON report to, or null to only print to stdout.
   */
  out: string | null;
}

/**
 * One store's entry in the default run plan.
 */
export interface SpikePlanEntry {
  /**
   * Store slug to probe.
   */
  slug: string;

  /**
   * Clients to try, in escalation order (cheapest first).
   */
  clients: SpikeClientKind[];

  /**
   * When true, stop at the first passing client instead of trying them all.
   */
  escalate: boolean;
}

/**
 * Aggregated verdict for one store x client combination.
 */
export interface SpikeVerdict {
  /**
   * Store slug the series ran against.
   */
  slug: string;

  /**
   * Client kind the series used.
   */
  client: SpikeClientKind;

  /**
   * True when every attempt in the series succeeded.
   */
  pass: boolean;

  /**
   * Every attempt in the series, in order.
   */
  attempts: SpikeAttempt[];
}
