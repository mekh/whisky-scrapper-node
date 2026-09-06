import { Injectable, Logger } from '@nestjs/common';

import { CurrencyConfig } from '~config';
import { ServerError, ServiceUnavailableError } from '~errors';
import { CurrencyRateInput, NbuRateRow } from '~types';
import { CurrencyUtils } from '~utils';

/**
 * Path of the NBU's documented date-range endpoint («Курс на діапазон дат за
 * валютою/металом»).
 */
const RANGE_PATH = '/NBU_Exchange/exchange_site';

/**
 * Backoff before the first retry. Doubled on each subsequent attempt.
 */
const RETRY_BASE_DELAY_MS = 500;

/**
 * Ceiling on the backoff, so a long retry chain cannot outlast the caller's
 * own budget.
 */
const RETRY_MAX_DELAY_MS = 5000;

/**
 * Fetches official rates from the National Bank of Ukraine.
 *
 * A small dedicated client rather than a reuse of `scrape/http`: that layer
 * exists to get past nineteen anti-bot-guarded retail sites, and none of it —
 * browser impersonation, per-store politeness jitter, end-of-catalogue status
 * handling — applies to a government open-data API that answers plain
 * requests. What is kept from it is the part that matters, a bounded timeout
 * and a small retry chain.
 *
 * The one hard rule about this source: **an empty response is not an error
 * here.** The API answers `HTTP 200` with `[]` both for a currency it does not
 * know and for a range that predates a currency's existence (EUR before
 * 1999), and this service cannot tell those apart. So it reports what it got,
 * and `CurrencyRateSyncService` — which validates codes against the database
 * first and sees the whole run — is what decides that nothing at all came back
 * and fails.
 */
@Injectable()
export class NbuRateService {
  private readonly logger = new Logger(NbuRateService.name);

  public constructor(private readonly config: CurrencyConfig) {}

  /**
   * Fetches one currency's rates over an inclusive day range.
   *
   * @param code - ISO 4217 alphabetic code; case does not matter to the API.
   * @param from - First day, as `YYYY-MM-DD`.
   * @param to - Last day, as `YYYY-MM-DD`.
   * @returns The rates, normalized to hryvnia per one unit and ascending by
   *   day. Empty when the source has nothing for that range.
   * @throws {ServiceUnavailableError} If every attempt failed.
   * @throws {ServerError} If the payload is not the expected shape, or a row
   *   contradicts itself.
   */
  public async fetchRange(
    code: string,
    from: string,
    to: string,
  ): Promise<CurrencyRateInput[]> {
    const wanted = code.trim().toUpperCase();
    const rows = await this.request(wanted, from, to);

    return rows.map((row) => this.toRate(row, wanted));
  }

  /**
   * Requests one range, retrying a failed attempt up to the configured count.
   *
   * @param code - Upper-case ISO 4217 code.
   * @param from - First day, as `YYYY-MM-DD`.
   * @param to - Last day, as `YYYY-MM-DD`.
   * @returns The raw rows the API returned.
   * @throws {ServiceUnavailableError} If every attempt failed.
   */
  private async request(
    code: string,
    from: string,
    to: string,
  ): Promise<NbuRateRow[]> {
    const url = this.buildUrl(code, from, to);
    const attempts = Math.max(1, this.config.nbuRetries);
    let last: unknown = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.attempt(url);
      } catch (error) {
        last = error;

        this.logger.warn(
          'NBU request for %s %s..%s failed (attempt %d/%d): %s',
          code,
          from,
          to,
          attempt,
          attempts,
          error instanceof Error ? error.message : String(error),
        );

        if (attempt < attempts) {
          await this.pause(attempt);
        }
      }
    }

    throw new ServiceUnavailableError(
      `NBU rates for ${code} ${from}..${to} are unavailable: `
        + `${last instanceof Error ? last.message : String(last)}`,
    );
  }

  /**
   * Performs one HTTP attempt against the range endpoint.
   *
   * @param url - The fully built request URL.
   * @returns The parsed rows.
   * @throws {Error} If the response status is not ok.
   * @throws {ServerError} If the body is not a JSON array of rate rows.
   */
  private async attempt(url: string): Promise<NbuRateRow[]> {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.config.nbuTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const payload: unknown = await response.json();

    return this.assertRows(payload, url);
  }

  /**
   * Builds the range request URL.
   *
   * @param code - Upper-case ISO 4217 code.
   * @param from - First day, as `YYYY-MM-DD`.
   * @param to - Last day, as `YYYY-MM-DD`.
   * @returns The absolute URL to request.
   */
  private buildUrl(code: string, from: string, to: string): string {
    const url = new URL(RANGE_PATH, this.config.nbuBaseUrl);

    url.searchParams.set('start', CurrencyUtils.toQueryDate(from));
    url.searchParams.set('end', CurrencyUtils.toQueryDate(to));
    url.searchParams.set('valcode', code.toLowerCase());
    url.searchParams.set('sort', 'exchangedate');
    url.searchParams.set('order', 'asc');
    url.searchParams.set('json', '');

    return url.toString();
  }

  /**
   * Checks that a parsed body is an array of rows carrying the fields this
   * project reads. A payload that is merely empty passes — see the class
   * comment for why that is not this layer's call.
   *
   * @param payload - The parsed response body.
   * @param url - The request URL, for the error message.
   * @returns The body as rate rows.
   * @throws {ServerError} If the shape is not what the API documents.
   */
  private assertRows(payload: unknown, url: string): NbuRateRow[] {
    if (!Array.isArray(payload)) {
      throw new ServerError(`NBU answered a non-array payload for ${url}`);
    }

    const bad = payload.find((row) => !this.isRow(row));

    if (bad) {
      throw new ServerError(
        `NBU row is missing expected fields: ${JSON.stringify(bad)}`,
      );
    }

    return payload as NbuRateRow[];
  }

  /**
   * Whether one parsed element carries every field the mapper reads.
   *
   * @param row - The element to test.
   * @returns True when it is shaped like a rate row.
   */
  private isRow(row: unknown): boolean {
    if (typeof row !== 'object' || row === null) {
      return false;
    }

    const candidate = row as Partial<NbuRateRow>;

    return typeof candidate.exchangedate === 'string'
      && typeof candidate.cc === 'string'
      && typeof candidate.rate === 'number'
      && typeof candidate.units === 'number'
      && typeof candidate.rate_per_unit === 'number';
  }

  /**
   * Normalizes one row and checks it belongs to the currency that was asked
   * for — a mismatch would mean the request went out with the wrong parameter,
   * which is worth catching here rather than storing.
   *
   * @param row - One raw response row.
   * @param code - The upper-case code that was requested.
   * @returns The storable rate.
   * @throws {ServerError} If the row names a different currency.
   */
  private toRate(row: NbuRateRow, code: string): CurrencyRateInput {
    const rate = CurrencyUtils.normalize(row);

    if (rate.code !== code) {
      throw new ServerError(
        `NBU answered ${rate.code} for a ${code} request`,
      );
    }

    return rate;
  }

  /**
   * Waits out the backoff before the next attempt.
   *
   * @param attempt - Which attempt just failed, one-based.
   * @returns Resolves once the delay has elapsed.
   */
  private async pause(attempt: number): Promise<void> {
    const delay = Math.min(
      RETRY_MAX_DELAY_MS,
      RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
    );

    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
