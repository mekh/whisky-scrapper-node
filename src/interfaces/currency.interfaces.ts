import type { ID } from './entity.interfaces';

/**
 * One row of the NBU's `exchange_site` response, as it arrives over the wire.
 *
 * Only the fields this project reads are modelled. `calcdate` (the business
 * day the rate was set on) and `special` (the USD calculation-conditions flag
 * added 2026-01-21) are deliberately absent: nothing reads them, and a field
 * declared here would invite someone to persist it.
 */
export interface NbuRateRow {
  /**
   * The day the rate applies to, in the NBU's `DD.MM.YYYY` format. Every
   * calendar day is present — weekends and holidays repeat the preceding
   * business day's value — so a response has no gaps to fill.
   */
  exchangedate: string;

  /**
   * ISO 4217 alphabetic code, upper-case (`USD`, `EUR`).
   */
  cc: string;

  /**
   * Hryvnia per `units` of the currency. **Never persist this directly**: for
   * every day before 2019-12-28 the NBU quoted USD and EUR per *100* units, so
   * this field is 100x the per-unit rate on two thirds of the history.
   */
  rate: number;

  /**
   * How many units of the currency `rate` is quoted for. `1` since
   * 2019-12-28, `100` before it.
   */
  units: number;

  /**
   * Hryvnia per one unit — the value this project stores. Equal to
   * `rate / units` on every one of the 20 589 USD and EUR rows checked, which
   * is why the mapper asserts the identity rather than trusting one field.
   */
  rate_per_unit: number;
}

/**
 * A rate ready to be written, after normalization.
 */
export interface CurrencyRateInput {
  /**
   * ISO 4217 alphabetic code, upper-case.
   */
  code: string;

  /**
   * Hryvnia per one unit of `code`.
   */
  rate: number;

  /**
   * The calendar day the rate applies to, as `YYYY-MM-DD`.
   */
  effectiveOn: string;
}

/**
 * A rate ready to be written, resolved to the currency row it belongs to.
 *
 * Separate from `CurrencyRateInput` because the source and every API speak ISO
 * codes while the table references `currency.id`: the code is resolved once,
 * in the core service, rather than joined on in every write.
 */
export interface CurrencyRateRow {
  /**
   * The currency this rate belongs to.
   */
  currencyId: ID;

  /**
   * Hryvnia per one unit of the currency.
   */
  rate: number;

  /**
   * The calendar day the rate applies to, as `YYYY-MM-DD`.
   */
  effectiveOn: string;
}

/**
 * The answer to "what was one unit of this currency worth on this day".
 */
export interface CurrencyRateLookup {
  /**
   * ISO 4217 alphabetic code, upper-case.
   */
  code: string;

  /**
   * The day that was asked about, as `YYYY-MM-DD`.
   */
  requestedOn: string;

  /**
   * The day the returned rate actually belongs to. Equal to `requestedOn`
   * except when the asked-for day is past the last synced one, where the most
   * recent earlier day is used instead — so a caller can always state which
   * rate it applied rather than implying one that was never published.
   */
  effectiveOn: string;

  /**
   * Hryvnia per one unit of `code`.
   */
  rate: number;
}

/**
 * One point of a rate series.
 */
export interface CurrencyRatePoint {
  /**
   * The calendar day, as `YYYY-MM-DD`.
   */
  effectiveOn: string;

  /**
   * Hryvnia per one unit of the series' currency.
   */
  rate: number;
}

/**
 * A rate series over a resolved date range.
 */
export interface CurrencyRateSeries {
  /**
   * ISO 4217 alphabetic code, upper-case.
   */
  code: string;

  /**
   * First day of the range actually answered, as `YYYY-MM-DD`. May be later
   * than the requested one when the request reached past the stored history.
   */
  from: string;

  /**
   * Last day of the range actually answered, as `YYYY-MM-DD`.
   */
  to: string;

  /**
   * The rates, ascending by day, with no gaps: the source publishes every
   * calendar day, and the handful its own first years omit are carried
   * forward on ingest.
   */
  points: CurrencyRatePoint[];
}

/**
 * What a caller asks the conversion service to convert.
 */
export interface CurrencyConvertRequest {
  /**
   * The amount, in `from`.
   */
  amount: number;

  /**
   * ISO 4217 code the amount is denominated in.
   */
  from: string;

  /**
   * ISO 4217 code to convert into.
   */
  to: string;

  /**
   * The day whose official rate to apply, as `YYYY-MM-DD`. Defaults to today
   * when absent.
   */
  on?: string;
}

/**
 * A completed conversion, stating the rate it used so the caller can show it.
 */
export interface CurrencyConversion {
  /**
   * The input amount, unchanged.
   */
  amount: number;

  /**
   * ISO 4217 code the input amount is denominated in.
   */
  from: string;

  /**
   * ISO 4217 code the result is denominated in.
   */
  to: string;

  /**
   * The day that was asked about, as `YYYY-MM-DD`.
   */
  requestedOn: string;

  /**
   * The day the applied rates belong to. See
   * `CurrencyRateLookup.effectiveOn`. Null for a base-to-base conversion,
   * which applies no rate at all.
   */
  effectiveOn: string | null;

  /**
   * Hryvnia per one unit of `from`. Exactly `1` when `from` is the base
   * currency.
   *
   * Both sides are reported rather than one "the rate", because a conversion
   * between two foreign currencies has two and no single number is the answer:
   * naming one of them would silently pick a side. A client showing "at the
   * NBU rate of N" takes whichever of the pair is not 1.
   */
  fromRate: number | null;

  /**
   * Hryvnia per one unit of `to`. Exactly `1` when `to` is the base currency.
   */
  toRate: number | null;

  /**
   * The converted amount, rounded to `CONVERTED_AMOUNT_SCALE` decimals.
   */
  converted: number;
}

/**
 * What one rate-sync run did.
 */
export interface CurrencyRateSyncReport {
  /**
   * Currency codes the run covered.
   */
  codes: string[];

  /**
   * First day requested, as `YYYY-MM-DD`.
   */
  from: string;

  /**
   * Last day requested, as `YYYY-MM-DD`.
   */
  to: string;

  /**
   * How many rows the NBU returned across every currency and chunk.
   */
  fetched: number;

  /**
   * How many rows were written. Equal to `fetched` in normal operation: the
   * write is an upsert, so a re-run over the same range overwrites the same
   * number of rows rather than inserting none.
   */
  written: number;
}

/**
 * The settings `CurrencyConfig` guarantees. Declared separately so services
 * type against the contract rather than the validated config class.
 */
export interface CurrencyConfigShape {
  /**
   * Origin of the NBU open-data API, without a trailing slash.
   */
  nbuBaseUrl: string;

  /**
   * How long one request to the NBU may take before it is aborted.
   */
  nbuTimeoutMs: number;

  /**
   * How many times a failed request is retried before the run gives up.
   */
  nbuRetries: number;

  /**
   * ISO 4217 codes the sync fetches, upper-case. The base currency is never
   * among them — it has no rate against itself.
   */
  rateCodes: string[];

  /**
   * Whether the daily rate schedule is armed.
   */
  cronEnabled: boolean;

  /**
   * Cron expression for the daily sync, evaluated in `timezone`.
   */
  cronExpression: string;

  /**
   * IANA timezone the cron expression is evaluated in.
   */
  timezone: string;

  /**
   * How many trailing days each scheduled run re-fetches.
   */
  syncWindowDays: number;
}

/**
 * The result of asking for one `(code, day)` rate, before the caller decides
 * what a miss means. Both nullable fields are null together, and only when
 * nothing at or before the requested day is stored.
 */
export interface CurrencyRateProbe {
  /**
   * ISO 4217 alphabetic code, upper-case.
   */
  code: string;

  /**
   * The day that was asked about, as `YYYY-MM-DD`.
   */
  requestedOn: string;

  /**
   * The day the found rate belongs to, or null when none was found.
   */
  effectiveOn: string | null;

  /**
   * Hryvnia per one unit of `code`, or null when none was found.
   */
  rate: number | null;
}

/**
 * The most recent stored rate of one currency.
 */
export interface CurrencyLatestRate {
  /**
   * ISO 4217 alphabetic code, upper-case.
   */
  code: string;

  /**
   * The day the rate belongs to, as `YYYY-MM-DD`. Can be **tomorrow**: the
   * NBU publishes the next business day's rate after 15:30 Kyiv time, and
   * discarding that would throw away the freshest thing the source has.
   */
  effectiveOn: string;

  /**
   * Hryvnia per one unit of `code`.
   */
  rate: number;
}

/**
 * What is stored for one currency, used to report and assert coverage.
 */
export interface CurrencyRateCoverageRow {
  /**
   * ISO 4217 alphabetic code, upper-case.
   */
  code: string;

  /**
   * How many days are stored.
   */
  days: number;

  /**
   * Earliest stored day, as `YYYY-MM-DD`.
   */
  firstDay: string;

  /**
   * Latest stored day, as `YYYY-MM-DD`.
   */
  lastDay: string;

  /**
   * How many days `firstDay`..`lastDay` spans, inclusive. Always equal to
   * `days`, since the stored series is gap-free by construction.
   */
  span: number;
}

/**
 * What a caller may ask a rate sync to cover. Every field is optional: asking
 * for nothing performs the routine trailing-window run.
 *
 * Split from `CurrencyRateSyncOptions` because this half, and only this half,
 * is what an HTTP request can carry.
 */
export interface CurrencyRateSyncRequest {
  /**
   * ISO 4217 codes to fetch. Defaults to the configured set.
   */
  codes?: string[];

  /**
   * First day to fetch, as `YYYY-MM-DD`. Defaults to the start of the
   * trailing window.
   */
  from?: string;

  /**
   * Last day to fetch, as `YYYY-MM-DD`. Defaults to tomorrow — the NBU
   * publishes the next business day's rate after 15:30 Kyiv time, and asking
   * for a day it has not published yet simply returns nothing.
   */
  to?: string;
}

/**
 * Everything one rate-sync run needs, including the two knobs only an
 * in-process caller (the backfill script) can supply.
 */
export interface CurrencyRateSyncOptions extends CurrencyRateSyncRequest {
  /**
   * Fetch and report without writing anything.
   */
  dryRun?: boolean;

  /**
   * Called with a human-readable line as the run progresses, so a long
   * backfill is observably alive.
   */
  onProgress?: (message: string) => void;
}

/**
 * A currency as a client picker needs it.
 */
export interface CurrencyOption {
  /**
   * ISO 4217 alphabetic code, upper-case. The value a client sends back.
   */
  code: string;

  /**
   * ISO 4217 numeric code.
   */
  numericCode: number;

  /**
   * Ukrainian display name.
   */
  nameUa: string;

  /**
   * Display symbol.
   */
  symbol: string;

  /**
   * True for the currency every price is stored in. Exactly one option
   * carries it, and converting to or from it applies no rate.
   */
  isBase: boolean;
}

/**
 * A run of calendar days the stored series is missing.
 */
export interface CurrencyRateGap {
  /**
   * ISO 4217 alphabetic code, upper-case.
   */
  code: string;

  /**
   * The last day present before the gap, as `YYYY-MM-DD`.
   */
  after: string;

  /**
   * The first day present after the gap, as `YYYY-MM-DD`.
   */
  before: string;

  /**
   * How many days are missing between the two.
   */
  missing: number;
}
