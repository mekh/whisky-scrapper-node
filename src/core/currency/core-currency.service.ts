import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import { BadRequestError } from '~errors';
import {
  CurrencyLatestRate,
  CurrencyRateCoverageRow,
  CurrencyRateGap,
  CurrencyRateInput,
  CurrencyRatePoint,
  CurrencyRateProbe,
  ID,
} from '~types';

import { CurrencyRateRepository } from './currency-rate.repository';
import { CurrencyEntity } from './currency.entity';
import { CurrencyRepository } from './currency.repository';

/**
 * Persistence-layer public API for the currency lookup and its rate series.
 *
 * One service over two entities, following `core/preference`: `currency_rate`
 * has no meaning apart from the `currency` it belongs to, is never read
 * without it, and splitting them would only make every caller import two
 * modules to ask one question.
 */
@Injectable()
export class CoreCurrencyService extends CoreBaseService<CurrencyEntity> {
  protected readonly uniqueFields: 'code'[] = ['code'];

  public constructor(
    protected readonly repo: CurrencyRepository,
    private readonly rates: CurrencyRateRepository,
  ) {
    super(repo);
  }

  /**
   * Reads the currencies on offer, base first then alphabetically.
   *
   * @returns The active currencies.
   */
  public async findActive(): Promise<CurrencyEntity[]> {
    return this.repo.findActive();
  }

  /**
   * Reads every currency, active or not.
   *
   * @returns Every currency, base first then alphabetically.
   */
  public async findAll(): Promise<CurrencyEntity[]> {
    return this.repo.findAll();
  }

  /**
   * Reads currencies by code, active or not.
   *
   * @param codes - Codes to read, case-insensitive.
   * @returns The matching currencies.
   */
  public async findByCodes(codes: string[]): Promise<CurrencyEntity[]> {
    return this.repo.findByCodes(codes);
  }

  /**
   * Writes rates, overwriting any already stored for the same currency and
   * day. Safe to call repeatedly and concurrently — see
   * `CurrencyRateRepository.upsertMany`.
   *
   * Resolving the ISO code to a currency id happens here rather than as a
   * join inside the write, so an unknown code fails with a readable message
   * instead of being silently dropped by the join.
   *
   * @param rates - Normalized rates, keyed by ISO code.
   * @returns How many rows were written.
   * @throws {BadRequestError} If a rate names a currency that does not exist.
   */
  public async upsertRates(rates: CurrencyRateInput[]): Promise<number> {
    if (!rates.length) {
      return 0;
    }

    const ids = await this.resolveIds(rates.map((rate) => rate.code));

    return this.rates.upsertMany(
      rates.map((rate) => ({
        currencyId: ids.get(rate.code) as ID,
        rate: rate.rate,
        effectiveOn: rate.effectiveOn,
      })),
    );
  }

  /**
   * Resolves a batch of `(code, day)` pairs to the rates in force on those
   * days, in as few statements as possible.
   *
   * @param pairs - The pairs to resolve.
   * @returns One probe per distinct pair; a pair with nothing stored at or
   *   before its day comes back with null `rate` and `effectiveOn`.
   */
  public async probeRates(
    pairs: { code: string; day: string }[],
  ): Promise<CurrencyRateProbe[]> {
    return this.rates.probe(pairs);
  }

  /**
   * Reads one currency's rates over an inclusive day range.
   *
   * @param code - ISO 4217 alphabetic code, upper-case.
   * @param from - First day, as `YYYY-MM-DD`.
   * @param to - Last day, as `YYYY-MM-DD`.
   * @returns The rates ascending by day.
   */
  public async findRateSeries(
    code: string,
    from: string,
    to: string,
  ): Promise<CurrencyRatePoint[]> {
    return this.rates.findSeries(code, from, to);
  }

  /**
   * Reads the newest stored rate of every currency.
   *
   * @returns One row per currency holding any rate.
   */
  public async findLatestRates(): Promise<CurrencyLatestRate[]> {
    return this.rates.findLatest();
  }

  /**
   * Finds the runs of days any currency's stored series is missing. Nothing
   * should ever be found — see `CurrencyRateRepository.findGaps`.
   *
   * @returns One row per gap.
   */
  public async rateGaps(): Promise<CurrencyRateGap[]> {
    return this.rates.findGaps();
  }

  /**
   * Summarizes what is stored per currency, for the backfill's report and its
   * gap-free assertion.
   *
   * @returns One row per currency holding any rate.
   */
  public async rateCoverage(): Promise<CurrencyRateCoverageRow[]> {
    return this.rates.coverage();
  }

  /**
   * Maps ISO codes to currency ids, failing closed on any it does not know.
   *
   * @param codes - Codes to resolve, in any case and with duplicates.
   * @returns Map from each upper-case code to its currency id.
   * @throws {BadRequestError} If any code is unknown.
   */
  private async resolveIds(codes: string[]): Promise<Map<string, ID>> {
    const wanted = [...new Set(codes.map((code) => code.trim().toUpperCase()))];
    const known = await this.repo.findByCodes(wanted);
    const ids = new Map(known.map((row) => [row.code, row.id]));
    const unknown = wanted.filter((code) => !ids.has(code));

    if (unknown.length) {
      throw new BadRequestError(
        `Unknown currency code(s): ${unknown.join(', ')}`,
      );
    }

    return ids;
  }
}
