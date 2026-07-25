import { randomBetween, sleep } from '../scrape-timing.util';

import type {
  ScrapeHttpClient,
  ScrapeHttpRequestOptions,
  ScrapeHttpResponse,
} from './http-client.interfaces';

const RETRIES = 3;
const HARD_STATUSES = new Set([403, 429]);
const SERVER_ERROR_MIN = 500;
const CLIENT_ERROR_MIN = 400;

/**
 * Wraps any transport with retry/backoff, ported from the Python
 * `BaseAdapter.get`: three attempts, exponential backoff with jitter. A 403 /
 * 429 / 5xx or a network error is retried with a longer backoff; other 4xx
 * responses are retried with a shorter one; the last failure is thrown once
 * attempts are exhausted.
 */
export class RetryingHttpClient implements ScrapeHttpClient {
  private readonly inner: ScrapeHttpClient;

  private readonly delayMultiplier: number;

  public constructor(inner: ScrapeHttpClient, delayMultiplier: number) {
    this.inner = inner;
    this.delayMultiplier = delayMultiplier;
  }

  /**
   * Performs a GET with retry/backoff.
   *
   * @param url - Absolute URL.
   * @param options - Optional query parameters and headers.
   * @returns The successful response.
   * @throws {Error} When every attempt fails.
   */
  public async get(
    url: string,
    options?: ScrapeHttpRequestOptions,
  ): Promise<ScrapeHttpResponse> {
    let lastError = '';

    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      try {
        const response = await this.inner.get(url, options);

        if (response.status < CLIENT_ERROR_MIN) {
          return response;
        }

        lastError = `HTTP ${response.status}`;
        await this.backoff(attempt, this.isHardStatus(response.status));
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await this.backoff(attempt, false);
      }
    }

    throw new Error(`Failed to fetch ${url}: ${lastError}`);
  }

  /**
   * Closes the wrapped client.
   *
   * @returns Resolves once closed.
   */
  public close(): Promise<void> {
    return this.inner.close();
  }

  /**
   * True for statuses that get the longer backoff (403 / 429 / 5xx).
   *
   * @param status - HTTP status code.
   * @returns Whether the status is a "hard" one.
   */
  private isHardStatus(status: number): boolean {
    return HARD_STATUSES.has(status) || status >= SERVER_ERROR_MIN;
  }

  /**
   * Sleeps for an exponential jittered backoff before the next attempt.
   *
   * @param attempt - Zero-based attempt index.
   * @param hard - Whether to use the longer (2–4 s) rather than shorter
   *   (1–3 s) base range.
   * @returns Resolves once the backoff has elapsed.
   */
  private backoff(attempt: number, hard: boolean): Promise<void> {
    const base = hard ? randomBetween(2, 4) : randomBetween(1, 3);
    const seconds = 2 ** attempt * base * (hard ? this.delayMultiplier : 1);

    return sleep(seconds * 1000);
  }
}
