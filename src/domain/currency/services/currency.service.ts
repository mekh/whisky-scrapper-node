import { Injectable } from '@nestjs/common';

import { CURRENCY_SERIES_MAX_DAYS } from '~constants';
import { CoreCurrencyService, CurrencyEntity } from '~core/currency';
import { BadRequestError, ServerError } from '~errors';
import {
  CurrencyLatestRate,
  CurrencyOption,
  CurrencyRateProbe,
  CurrencyRateSeries,
} from '~types';
import { CurrencyUtils } from '~utils';

/**
 * How long the currency lookup is held in memory. The table only ever changes
 * through a migration, so this is a safety valve rather than a real
 * invalidation strategy — it keeps a deploy that adds a currency from needing
 * a restart to be noticed.
 */
const LOOKUP_TTL_MS = 60 * 1000;

/**
 * The read side of the currency feature: what can be displayed, and what a
 * unit of it was worth on a given day.
 */
@Injectable()
export class CurrencyService {
  private lookup: Map<string, CurrencyEntity> | null = null;

  private lookupExpiresAt = 0;

  public constructor(private readonly currencies: CoreCurrencyService) {}

  /**
   * Lists the currencies on offer, base first then alphabetically.
   *
   * @returns The options a client may choose between.
   */
  public async options(): Promise<CurrencyOption[]> {
    const active = await this.currencies.findActive();

    return active.map((currency) => ({
      code: currency.code,
      numericCode: currency.numericCode,
      nameUa: currency.nameUa,
      symbol: currency.symbol,
      isBase: currency.isBase,
    }));
  }

  /**
   * Resolves the rates of several currencies on one day.
   *
   * A row whose `rate` is null means nothing is stored at or before that day —
   * a purchase older than the currency itself, or an empty rates table. It is
   * reported rather than hidden, so a client can say "not convertible"
   * instead of showing a number nobody published.
   *
   * @param codes - ISO 4217 codes, case-insensitive.
   * @param day - The day to resolve, as `YYYY-MM-DD`. Defaults to today.
   * @returns One row per requested currency, in the order asked for.
   * @throws {BadRequestError} If a code is unknown.
   */
  public async ratesOn(
    codes: string[],
    day?: string,
  ): Promise<CurrencyRateProbe[]> {
    const on = day ?? CurrencyUtils.today();
    const wanted = await this.assertKnown(codes);
    const base = await this.baseCode();
    const probes = await this.currencies.probeRates(
      wanted
        .filter((code) => code !== base)
        .map((code) => ({ code, day: on })),
    );

    const byCode = new Map(probes.map((probe) => [probe.code, probe]));

    return wanted.map((code) =>
      code === base
        ? { code, requestedOn: on, effectiveOn: on, rate: 1 }
        : byCode.get(code)
          ?? { code, requestedOn: on, effectiveOn: null, rate: null }
    );
  }

  /**
   * Reads one currency's rate series over an inclusive day range.
   *
   * @param code - ISO 4217 code, case-insensitive.
   * @param from - First day, as `YYYY-MM-DD`.
   * @param to - Last day, as `YYYY-MM-DD`.
   * @returns The series, with the range it actually covers echoed back: when
   *   the request reached past the stored history the bounds are narrowed to
   *   the first and last day returned, so a client never has to guess whether
   *   a short answer is a gap or the edge of the data.
   * @throws {BadRequestError} If the code is unknown, the range is inverted,
   *   or it is longer than `CURRENCY_SERIES_MAX_DAYS`.
   */
  public async series(
    code: string,
    from: string,
    to: string,
  ): Promise<CurrencyRateSeries> {
    const [wanted] = await this.assertKnown([code]);

    if (!wanted) {
      throw new ServerError('Currency code resolved to nothing');
    }

    this.assertRange(from, to);

    const points = await this.currencies.findRateSeries(wanted, from, to);
    const first = points.at(0);
    const last = points.at(-1);

    return {
      code: wanted,
      from: first?.effectiveOn ?? from,
      to: last?.effectiveOn ?? to,
      points,
    };
  }

  /**
   * Reads the newest stored rate of every currency.
   *
   * The day can be **tomorrow**: the NBU publishes the next business day's
   * rate after 15:30 Kyiv time, and it is reported as it is stored rather than
   * clamped to today.
   *
   * @returns One row per currency holding any rate, alphabetically.
   */
  public async latest(): Promise<CurrencyLatestRate[]> {
    return this.currencies.findLatestRates();
  }

  /**
   * The currency lookup, by upper-case code, memoized for `LOOKUP_TTL_MS`.
   *
   * @returns Every currency, active or not — an inactive one still has to
   *   convert historical records.
   */
  public async all(): Promise<Map<string, CurrencyEntity>> {
    const now = Date.now();

    if (this.lookup && now < this.lookupExpiresAt) {
      return this.lookup;
    }

    const rows = await this.currencies.findAll();
    const fresh = new Map(rows.map((row) => [row.code, row]));

    this.lookup = fresh;
    this.lookupExpiresAt = now + LOOKUP_TTL_MS;

    return fresh;
  }

  /**
   * The code of the base currency — the one every price is stored in.
   *
   * @returns The base currency's code.
   * @throws {ServerError} If no currency is marked as the base, which would
   *   mean the seed migration never ran.
   */
  public async baseCode(): Promise<string> {
    const all = await this.all();
    const base = [...all.values()].find((currency) => currency.isBase);

    if (!base) {
      throw new ServerError('No base currency is configured');
    }

    return base.code;
  }

  /**
   * Normalizes codes and rejects any the database does not know.
   *
   * @param codes - Codes as the caller spelled them.
   * @returns The upper-case codes, duplicates collapsed, order preserved.
   * @throws {BadRequestError} If the list is empty or holds an unknown code.
   */
  private async assertKnown(codes: string[]): Promise<string[]> {
    const wanted = [
      ...new Set(
        codes.map((code) => code.trim().toUpperCase()).filter(Boolean),
      ),
    ];

    if (!wanted.length) {
      throw new BadRequestError('No currency code given');
    }

    const all = await this.all();
    const unknown = wanted.filter((code) => !all.has(code));

    if (unknown.length) {
      throw new BadRequestError(
        `Unknown currency code(s): ${unknown.join(', ')}`,
      );
    }

    return wanted;
  }

  /**
   * Checks a requested series range is usable.
   *
   * @param from - First day, as `YYYY-MM-DD`.
   * @param to - Last day, as `YYYY-MM-DD`.
   * @throws {BadRequestError} If the range is inverted or too long.
   */
  private assertRange(from: string, to: string): void {
    if (from > to) {
      throw new BadRequestError(`Inverted range: ${from}..${to}`);
    }

    const span = CurrencyUtils.daysBetween(from, to);

    if (span > CURRENCY_SERIES_MAX_DAYS) {
      throw new BadRequestError(
        `Range of ${span} days exceeds the ${CURRENCY_SERIES_MAX_DAYS}-day `
          + 'maximum',
      );
    }
  }
}
