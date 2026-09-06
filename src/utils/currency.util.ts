import { CONVERTED_AMOUNT_SCALE, RATE_SCALE } from '~constants';
import { ServerError } from '~errors';
import { CurrencyRateInput, NbuRateRow } from '~types';

/**
 * Milliseconds in a calendar day. Day arithmetic here is done in UTC, which
 * `effectiveOn` is defined in, so no daylight-saving shift can move a date.
 */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How far `rate / units` may differ from the NBU's own `rate_per_unit` before
 * the row is rejected. Both are float64 values around 50, so anything beyond
 * this is a real disagreement rather than representation error.
 */
const RATE_IDENTITY_TOLERANCE = 1e-9;

/**
 * A bare `YYYY-MM-DD` day.
 */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The NBU's wire date format, `DD.MM.YYYY`.
 */
const WIRE_DAY = /^(\d{2})\.(\d{2})\.(\d{4})$/;

/**
 * Pure helpers for the currency feature: the conversion arithmetic, UTC day
 * arithmetic, and the mapping of an NBU response row onto a storable rate.
 * Stateless on purpose — all of it is unit-testable without a database or a
 * network call, which matters most for `normalize`, whose job is to defuse a
 * silent hundred-fold error in the source data.
 */
export class CurrencyUtils {
  /**
   * Rounds a converted monetary amount to the displayed number of decimals,
   * removing the binary-float noise that `amount * a / b` leaves behind.
   *
   * @param value - The raw converted amount.
   * @returns The amount rounded to `CONVERTED_AMOUNT_SCALE` decimals.
   */
  public static round(value: number): number {
    return CurrencyUtils.roundTo(value, CONVERTED_AMOUNT_SCALE);
  }

  /**
   * Converts an amount between two currencies through the hryvnia.
   *
   * Both rates are hryvnia per one unit, so the base currency's rate is `1`
   * and the two directions fall out of one expression: multiplying by
   * `fromRate` lifts the amount into hryvnia, dividing by `toRate` lands it in
   * the target. That is why there is no separate `toUah`/`fromUah` pair to
   * keep in step.
   *
   * @param amount - The amount, denominated in the source currency.
   * @param fromRate - Hryvnia per one unit of the source currency.
   * @param toRate - Hryvnia per one unit of the target currency.
   * @returns The converted amount, rounded for display.
   * @throws {ServerError} If either rate is not a positive finite number.
   */
  public static convert(
    amount: number,
    fromRate: number,
    toRate: number,
  ): number {
    if (!CurrencyUtils.isPositive(fromRate)) {
      throw new ServerError(`Invalid source rate: ${fromRate}`);
    }

    if (!CurrencyUtils.isPositive(toRate)) {
      throw new ServerError(`Invalid target rate: ${toRate}`);
    }

    return CurrencyUtils.round(amount * fromRate / toRate);
  }

  /**
   * The current UTC calendar day.
   *
   * @returns Today as `YYYY-MM-DD`.
   */
  public static today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Shifts a calendar day by whole days, in UTC.
   *
   * @param day - The starting day, as `YYYY-MM-DD`.
   * @param delta - How many days to add; negative moves backwards.
   * @returns The shifted day, as `YYYY-MM-DD`.
   * @throws {ServerError} If `day` is not a `YYYY-MM-DD` value.
   */
  public static shiftDays(day: string, delta: number): string {
    const at = CurrencyUtils.parseDay(day);

    return new Date(at + delta * MS_PER_DAY).toISOString().slice(0, 10);
  }

  /**
   * Counts the days an inclusive range spans.
   *
   * @param from - First day, as `YYYY-MM-DD`.
   * @param to - Last day, as `YYYY-MM-DD`.
   * @returns How many days the range covers, both ends included. Zero or
   *   negative when `to` precedes `from`.
   * @throws {ServerError} If either value is not a `YYYY-MM-DD` value.
   */
  public static daysBetween(from: string, to: string): number {
    const start = CurrencyUtils.parseDay(from);
    const end = CurrencyUtils.parseDay(to);

    return Math.round((end - start) / MS_PER_DAY) + 1;
  }

  /**
   * Renders a day in the compact form the NBU query string expects.
   *
   * @param day - The day, as `YYYY-MM-DD`.
   * @returns The same day as `YYYYMMDD`.
   * @throws {ServerError} If `day` is not a `YYYY-MM-DD` value.
   */
  public static toQueryDate(day: string): string {
    if (!ISO_DAY.test(day)) {
      throw new ServerError(`Invalid date: ${day}`);
    }

    return day.replace(/-/g, '');
  }

  /**
   * Parses the NBU's `DD.MM.YYYY` date into a calendar day.
   *
   * @param wire - The date exactly as the API sent it.
   * @returns The day as `YYYY-MM-DD`.
   * @throws {ServerError} If the value is not in the expected format.
   */
  public static fromWireDate(wire: string): string {
    const match = WIRE_DAY.exec(wire);

    if (!match) {
      throw new ServerError(`Unexpected NBU date format: ${wire}`);
    }

    return `${match[3]}-${match[2]}-${match[1]}`;
  }

  /**
   * Maps one NBU response row onto a storable rate, normalized to hryvnia per
   * **one** unit.
   *
   * This is the single most important function in the feature. Until
   * 2019-12-27 the bank quoted USD and EUR per *100* units, so `row.rate` is a
   * hundred times the per-unit value across two thirds of the history, and
   * persisting it unchanged would misprice exactly the old purchases this
   * feature exists to convert — silently, since the number still looks like a
   * plausible rate.
   *
   * The division is done here rather than reading `rate_per_unit` directly, and
   * the two are then required to agree: that way a response that ever stops
   * carrying `rate_per_unit`, or disagrees with itself, fails loudly instead of
   * writing a wrong rate.
   *
   * @param row - One row of the `exchange_site` response.
   * @returns The rate ready to be upserted.
   * @throws {ServerError} If `units` is unusable, or the row's own two rate
   *   fields do not agree.
   */
  public static normalize(row: NbuRateRow): CurrencyRateInput {
    if (!CurrencyUtils.isPositive(row.units)) {
      throw new ServerError(
        `NBU row for ${row.cc} on ${row.exchangedate} has units=${row.units}`,
      );
    }

    if (!CurrencyUtils.isPositive(row.rate)) {
      throw new ServerError(
        `NBU row for ${row.cc} on ${row.exchangedate} has rate=${row.rate}`,
      );
    }

    const perUnit = row.rate / row.units;
    const stated = row.rate_per_unit;

    if (Math.abs(perUnit - stated) > RATE_IDENTITY_TOLERANCE) {
      throw new ServerError(
        `NBU row for ${row.cc} on ${row.exchangedate} disagrees with itself: `
          + `rate/units=${perUnit} but rate_per_unit=${stated}`,
      );
    }

    return {
      code: row.cc.trim().toUpperCase(),
      rate: CurrencyUtils.roundTo(perUnit, RATE_SCALE),
      effectiveOn: CurrencyUtils.fromWireDate(row.exchangedate),
    };
  }

  /**
   * Fills every missing day of a fetched series by carrying the last known
   * rate forward.
   *
   * The NBU publishes a rate for **every** calendar day — a weekend or a
   * holiday simply repeats the preceding business day's value — so a hole is
   * not a signal, it is an omission. Its own first years have twelve of them
   * (1996-11-18, 1997-11-08..11 and seven more), and while no purchase this
   * application records can fall there, a series with holes forces every
   * reader to decide what a hole means. Carrying forward is the same rule the
   * source applies to weekends, so the filled days say exactly what the bank
   * would have said: the rate in force that day.
   *
   * Only the interior is filled. The days before the first rate and after the
   * last are the edges of what the source has, not gaps, so widening the range
   * is never this function's job — which also makes it deterministic: the
   * result depends on the fetched rows alone, never on what is already stored.
   *
   * @param rates - Rates for a single currency, any order.
   * @returns The same rates plus one carried-forward entry per missing day,
   *   ascending by day. Returns the input unchanged when it holds fewer than
   *   two days.
   * @throws {ServerError} If the rates name more than one currency, which
   *   would silently carry one currency's value onto another's day.
   */
  public static fillGaps(rates: CurrencyRateInput[]): CurrencyRateInput[] {
    if (rates.length < 2) {
      return [...rates];
    }

    const codes = new Set(rates.map((rate) => rate.code));

    if (codes.size > 1) {
      throw new ServerError(
        `fillGaps needs one currency, got ${[...codes].join(', ')}`,
      );
    }

    const sorted = [...rates].sort((left, right) =>
      left.effectiveOn < right.effectiveOn ? -1 : 1
    );
    const filled: CurrencyRateInput[] = [];

    sorted.forEach((rate, index) => {
      const previous = sorted[index - 1];

      if (previous) {
        filled.push(...CurrencyUtils.bridge(previous, rate.effectiveOn));
      }

      filled.push(rate);
    });

    return filled;
  }

  /**
   * Splits an inclusive day range into per-calendar-year chunks.
   *
   * The API answers the full 28-year history of a currency in one request, so
   * this is not a size limit — it is so that a run which fails partway retries
   * one year rather than starting the history over.
   *
   * @param from - First day of the range, as `YYYY-MM-DD`.
   * @param to - Last day of the range, as `YYYY-MM-DD`.
   * @returns The chunks in ascending order; empty when `from` is after `to`.
   */
  public static splitByYear(
    from: string,
    to: string,
  ): { from: string; to: string }[] {
    const chunks: { from: string; to: string }[] = [];
    let cursor = from;

    while (cursor <= to) {
      const yearEnd = `${cursor.slice(0, 4)}-12-31`;
      const end = yearEnd < to ? yearEnd : to;

      chunks.push({ from: cursor, to: end });
      cursor = CurrencyUtils.shiftDays(end, 1);
    }

    return chunks;
  }

  /**
   * Repeats one rate across the days between it and the next one present.
   *
   * @param previous - The last rate the source actually published.
   * @param next - The day the next published rate falls on.
   * @returns One copy of `previous` per missing day, ascending; empty when the
   *   two days are consecutive.
   */
  private static bridge(
    previous: CurrencyRateInput,
    next: string,
  ): CurrencyRateInput[] {
    const missing = CurrencyUtils.daysBetween(previous.effectiveOn, next) - 2;

    if (missing < 1) {
      return [];
    }

    return Array.from({ length: missing }, (_, offset) => ({
      code: previous.code,
      rate: previous.rate,
      effectiveOn: CurrencyUtils.shiftDays(previous.effectiveOn, offset + 1),
    }));
  }

  /**
   * Rounds to a fixed number of decimals.
   *
   * @param value - The raw value.
   * @param scale - How many decimals to keep.
   * @returns The rounded value.
   */
  private static roundTo(value: number, scale: number): number {
    const factor = 10 ** scale;

    return Math.round(value * factor) / factor;
  }

  /**
   * Whether a value is usable as a rate or a unit count.
   *
   * @param value - The value to test.
   * @returns True when it is a finite number greater than zero.
   */
  private static isPositive(value: number): boolean {
    return Number.isFinite(value) && value > 0;
  }

  /**
   * Parses a calendar day into epoch milliseconds at UTC midnight.
   *
   * @param day - The day, as `YYYY-MM-DD`.
   * @returns Epoch milliseconds.
   * @throws {ServerError} If the value is not a `YYYY-MM-DD` value.
   */
  private static parseDay(day: string): number {
    if (!ISO_DAY.test(day)) {
      throw new ServerError(`Invalid date: ${day}`);
    }

    const at = Date.parse(`${day}T00:00:00.000Z`);

    if (!Number.isFinite(at)) {
      throw new ServerError(`Invalid date: ${day}`);
    }

    return at;
  }
}
