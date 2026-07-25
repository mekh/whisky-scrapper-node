/**
 * Per-request options for a scrape HTTP client.
 */
export interface ScrapeHttpRequestOptions {
  /**
   * Query-string parameters; numbers are stringified.
   */
  params?: Record<string, string | number>;

  /**
   * Extra request headers merged over the client's defaults.
   */
  headers?: Record<string, string>;
}

/**
 * A response from a scrape HTTP client. The body is buffered once, so `text`
 * and `json` can both be read.
 */
export interface ScrapeHttpResponse {
  /**
   * HTTP status code.
   */
  status: number;

  /**
   * Lower-cased response headers.
   */
  headers: Record<string, string>;

  /**
   * The response body as text.
   *
   * @returns The body text.
   */
  text(): string;

  /**
   * The response body parsed as JSON.
   *
   * @returns The parsed value.
   */
  json<T = unknown>(): T;
}

/**
 * A transport used to fetch store pages/APIs. Implementations differ only in
 * how they present themselves to the server (plain fetch vs. impersonation).
 */
export interface ScrapeHttpClient {
  /**
   * Performs a GET request.
   *
   * @param url - Absolute URL.
   * @param options - Optional query parameters and headers.
   * @returns The buffered response.
   */
  get(
    url: string,
    options?: ScrapeHttpRequestOptions,
  ): Promise<ScrapeHttpResponse>;

  /**
   * Releases the client's resources.
   *
   * @returns Resolves once closed.
   */
  close(): Promise<void>;
}

/**
 * Which transport a store uses.
 */
export enum HttpStrategy {
  /**
   * Node's global fetch with realistic headers.
   */
  PLAIN = 'plain',
  /**
   * `impit` impersonating Chrome (browser TLS/JA3 + HTTP/2 fingerprint).
   */
  IMPERSONATE = 'impersonate',
}
