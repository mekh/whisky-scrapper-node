import { Injectable, Logger } from '@nestjs/common';

import { CurrencyConfig } from '~config';
import { CoreCurrencyService } from '~core/currency';
import { BadRequestError, ServiceUnavailableError } from '~errors';
import {
  CurrencyRateInput,
  CurrencyRateSyncOptions,
  CurrencyRateSyncReport,
} from '~types';
import { CurrencyUtils } from '~utils';

import { NbuRateService } from './nbu-rate.service';

/**
 * Fetches official rates and writes them, and is the only thing that does.
 *
 * The backfill script, the daily cron and the manual endpoint all call this,
 * so the `units` normalization and the empty-response rule have exactly one
 * implementation rather than three that can drift apart.
 *
 * Re-running is a supported, first-class case. The write is a single
 * `INSERT ... ON CONFLICT DO UPDATE` on `(code, effectiveOn)`, so any number
 * of runs a day — even concurrent ones — is safe, the last one wins, and a
 * value stored wrongly is corrected rather than duplicated. Nothing here takes
 * a lock or asks whether today has already been synced: unlike a scrape this
 * costs one small request and is perfectly idempotent, so a guard would only
 * be able to prevent a repair.
 */
@Injectable()
export class CurrencyRateSyncService {
  private readonly logger = new Logger(CurrencyRateSyncService.name);

  public constructor(
    private readonly currencies: CoreCurrencyService,
    private readonly nbu: NbuRateService,
    private readonly config: CurrencyConfig,
  ) {}

  /**
   * Runs one sync.
   *
   * @param options - Which currencies and days to cover; every field has a
   *   default, so `sync()` performs the routine trailing-window run.
   * @returns What the run fetched and wrote.
   * @throws {BadRequestError} If a requested code is unknown, is the base
   *   currency, or the range is inverted.
   * @throws {ServiceUnavailableError} If the source returned nothing at all,
   *   which means the request or the API changed rather than that the days do
   *   not exist.
   */
  public async sync(
    options: CurrencyRateSyncOptions = {},
  ): Promise<CurrencyRateSyncReport> {
    const codes = await this.resolveCodes(options.codes);
    const to = options.to ?? CurrencyUtils.shiftDays(CurrencyUtils.today(), 1);
    const from = options.from ?? this.windowStart();

    if (from > to) {
      throw new BadRequestError(`Inverted range: ${from}..${to}`);
    }

    const report = await this.run(codes, from, to, options);

    if (!report.fetched) {
      throw new ServiceUnavailableError(
        `NBU returned no rates at all for ${codes.join(', ')} ${from}..${to}`,
      );
    }

    return report;
  }

  /**
   * Fetches every currency over every chunk of the range and writes what came
   * back.
   *
   * @param codes - Validated, upper-case codes.
   * @param from - First day, as `YYYY-MM-DD`.
   * @param to - Last day, as `YYYY-MM-DD`.
   * @param options - The run's options, for `dryRun` and progress.
   * @returns What the run fetched and wrote.
   */
  private async run(
    codes: string[],
    from: string,
    to: string,
    options: CurrencyRateSyncOptions,
  ): Promise<CurrencyRateSyncReport> {
    const chunks = CurrencyUtils.splitByYear(from, to);
    let fetched = 0;
    let written = 0;

    for (const code of codes) {
      const rates = await this.fetchCode(code, chunks, options);

      fetched += rates.length;

      if (!rates.length) {
        this.logger.warn(
          'NBU returned no rates for %s over %s..%s',
          code,
          from,
          to,
        );
      }

      if (!options.dryRun && rates.length) {
        written += await this.currencies.upsertRates(rates);
      }
    }

    return { codes, from, to, fetched, written };
  }

  /**
   * Fetches one currency across the range's chunks.
   *
   * The range is split per calendar year even though the API answers a whole
   * 28-year history in one request: a run that fails partway then retries one
   * year rather than starting the history again.
   *
   * Whatever comes back is passed through `CurrencyUtils.fillGaps` before it
   * is returned, so the days the source omits — twelve of them, all in
   * 1996-1997 — are stored carrying the last known rate forward rather than
   * left as holes every reader would have to interpret.
   *
   * @param code - Upper-case ISO 4217 code.
   * @param chunks - The day ranges to request, ascending.
   * @param options - The run's options, for progress reporting.
   * @returns Every rate the source returned for this currency.
   */
  private async fetchCode(
    code: string,
    chunks: { from: string; to: string }[],
    options: CurrencyRateSyncOptions,
  ): Promise<CurrencyRateInput[]> {
    const collected: CurrencyRateInput[] = [];

    for (const chunk of chunks) {
      const rates = await this.nbu.fetchRange(code, chunk.from, chunk.to);

      collected.push(...rates);
      options.onProgress?.(
        `${code} ${chunk.from}..${chunk.to}: ${rates.length} day(s)`,
      );
    }

    /**
     * Filled across the whole currency rather than per chunk, so a hole that
     * straddles a year boundary is bridged like any other.
     */
    const filled = CurrencyUtils.fillGaps(collected);
    const carried = filled.length - collected.length;

    if (carried) {
      options.onProgress?.(
        `${code}: carried the last known rate into ${carried} day(s) the `
          + 'source does not publish',
      );
    }

    return filled;
  }

  /**
   * Validates the requested codes against the database and normalizes them.
   *
   * Fails closed on purpose: an unknown code would otherwise reach the API,
   * come back as `HTTP 200 []` — which is what the NBU answers for a currency
   * it does not know — and be indistinguishable from a range with no data. A
   * readable error here is the only place that distinction can be made.
   *
   * @param requested - Codes the caller asked for, or undefined for the
   *   configured set.
   * @returns The upper-case codes to fetch.
   * @throws {BadRequestError} If any code is unknown or is the base currency.
   */
  private async resolveCodes(requested?: string[]): Promise<string[]> {
    const wanted = [
      ...new Set(
        (requested ?? this.config.rateCodes)
          .map((code) => code.trim().toUpperCase())
          .filter(Boolean),
      ),
    ];

    if (!wanted.length) {
      throw new BadRequestError('No currency codes to sync');
    }

    const known = await this.currencies.findByCodes(wanted);
    const byCode = new Map(known.map((currency) => [currency.code, currency]));
    const unknown = wanted.filter((code) => !byCode.has(code));

    if (unknown.length) {
      throw new BadRequestError(
        `Unknown currency code(s): ${unknown.join(', ')}`,
      );
    }

    const base = wanted.filter((code) => byCode.get(code)?.isBase);

    if (base.length) {
      throw new BadRequestError(
        `${base.join(', ')} is the base currency and has no rate to fetch`,
      );
    }

    return wanted;
  }

  /**
   * First day of the routine trailing window.
   *
   * A window rather than a single day so that a run missed to a restart, a
   * deploy or an outage heals itself at the next tick — one request covers the
   * whole week either way.
   *
   * @returns The window's first day, as `YYYY-MM-DD`.
   */
  private windowStart(): string {
    const span = Math.max(1, this.config.syncWindowDays);

    return CurrencyUtils.shiftDays(CurrencyUtils.today(), -(span - 1));
  }
}
