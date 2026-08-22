/**
 * Inner boundaries (UAH) of the dashboard price histogram, fed to Postgres
 * `width_bucket`. Bucket 0 is everything below the first boundary and the
 * last bucket is open-ended above the final one. Calibrated on production
 * data so the buckets stay comparably filled.
 */
export const DASHBOARD_PRICE_BUCKETS = [
  500,
  1000,
  2000,
  3000,
  5000,
  10000,
] as const;

/**
 * Hard cap on the `from`..`to` span (days) a dashboard range request may ask
 * for — two years covers every preset while bounding query cost.
 */
export const DASHBOARD_MAX_RANGE_DAYS = 732;

/**
 * When the caller does not pin a granularity, ranges longer than this many
 * days are downsampled to weekly buckets to keep the payload bounded.
 */
export const DASHBOARD_AUTO_WEEK_DAYS = 120;

/**
 * Default number of movers returned per direction.
 */
export const DASHBOARD_MOVERS_LIMIT = 10;

/**
 * Upper bound a movers request may raise `limit` to.
 */
export const DASHBOARD_MOVERS_MAX_LIMIT = 50;
