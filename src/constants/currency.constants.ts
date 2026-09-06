/**
 * Column width of a currency's Ukrainian display name.
 */
export const CURRENCY_NAME_MAX_LENGTH = 64;

/**
 * Column width of a currency's display symbol (`$`, `€`, `₴`).
 */
export const CURRENCY_SYMBOL_MAX_LENGTH = 8;

/**
 * Precision and scale of a stored exchange rate.
 *
 * Deliberately **not** the shared `PRICE_PRECISION`/`PRICE_SCALE`, which are
 * `numeric(12,2)`. Measured over the whole NBU history of USD and EUR, a
 * normalized rate carries up to **six** decimals (`15.768556` on 2014-12-31),
 * so a scale of 2 would silently truncate every rate of the hryvnia's
 * high-inflation years. The integer part needs three digits at most (the
 * observed range is `1.899` to `52.25`), and 18 total leaves room for a
 * currency quoted far lower than the dollar.
 */
export const RATE_PRECISION = 18;

export const RATE_SCALE = 6;

/**
 * How many decimals a converted monetary amount is rounded to.
 */
export const CONVERTED_AMOUNT_SCALE = 2;

/**
 * The earliest day a `--full` backfill asks the NBU for.
 *
 * One floor serves every currency: the API answers with the days that exist
 * and omits the rest, so a currency younger than this (the euro, first quoted
 * on 1999-01-01) needs no floor of its own. Measured against the live API, the
 * oldest day the source has at all is **1996-01-06**, for the dollar.
 */
export const CURRENCY_HISTORY_FLOOR = '1996-01-01';

/**
 * Longest span `GET /currency/rate/series` will answer in one request, in
 * days. Mirrors `DASHBOARD_MAX_RANGE_DAYS` — the same reasoning applies, and
 * two different caps on two range endpoints would only be a surprise.
 */
export const CURRENCY_SERIES_MAX_DAYS = 732;

/**
 * How many `(code, day)` rates the in-process conversion cache holds before
 * the oldest entries are dropped.
 *
 * A rate for a **past** day is immutable — the NBU never restates one — so
 * caching it needs no invalidation at all. Only the newest day can still
 * change (a same-day re-sync), which is why `CURRENCY_LATEST_CACHE_TTL_MS`
 * exists alongside this.
 */
export const CURRENCY_RATE_CACHE_SIZE = 4096;

/**
 * How long a rate whose day is today or later may be served from the cache.
 * Short, because that row is the one a re-sync can overwrite.
 */
export const CURRENCY_LATEST_CACHE_TTL_MS = 60 * 1000;
