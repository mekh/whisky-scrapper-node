import { DashboardBreakdownBy, DashboardGranularity } from '~enums';

import { ID } from './entity.interfaces';

/**
 * Dimension a per-day series can additionally be partitioned by.
 */
export type DashboardSeriesGrouping = 'store' | 'country';

export interface DashboardRangeQuery {
  /**
   * Inclusive range start, a UTC calendar day (`YYYY-MM-DD`). Matches
   * `price_snapshot.capturedOn`, which the scraper stamps with the UTC day.
   */
  from: string;

  /**
   * Inclusive range end, a UTC calendar day (`YYYY-MM-DD`).
   */
  to: string;

  /**
   * Store slugs to scope every metric to (CSV in the query string). Absent
   * means all stores.
   */
  stores?: string[];
}

export interface DashboardSeriesQuery extends DashboardRangeQuery {
  /**
   * When true, the response additionally carries one series per store (the
   * same `stores` scope applies). The total is always returned.
   */
  byStore?: boolean;

  /**
   * When true, the response additionally carries one series per product
   * country. Products without a country fall under the `unknown` key.
   */
  byCountry?: boolean;

  /**
   * Bucketing of the returned points. Absent lets the service pick: daily,
   * escalating to weekly past `DASHBOARD_AUTO_WEEK_DAYS`. Always echoed in
   * the response.
   */
  granularity?: DashboardGranularity;
}

export interface DashboardBreakdownQuery {
  /**
   * Dimension to slice the in-stock assortment by.
   */
  by: DashboardBreakdownBy;

  /**
   * Capture day to slice at (`YYYY-MM-DD`). Absent means the latest captured
   * day; the resolved day is echoed in the response.
   */
  date?: string;

  /**
   * Store slugs to scope the slice to (CSV in the query string).
   */
  stores?: string[];
}

export interface DashboardMoversQuery extends DashboardRangeQuery {
  /**
   * Movers returned per direction. Defaults to `DASHBOARD_MOVERS_LIMIT`,
   * capped at `DASHBOARD_MOVERS_MAX_LIMIT`.
   */
  limit?: number;

  /**
   * Minimum starting price (UAH) a listing must have had to qualify — a
   * noise floor for cheap items whose small absolute moves read as large
   * percentages. Absent means no floor.
   */
  minPrice?: number;
}

export interface DashboardStoreCoverage {
  /**
   * Store slug — the filter vocabulary every dashboard endpoint accepts.
   */
  slug: string;

  /**
   * Human-readable store name.
   */
  name: string;

  /**
   * Brand color configured for the store, or null to let the client derive
   * a deterministic fallback hue.
   */
  color: string | null;

  /**
   * Whether the store is currently enabled for syncing.
   */
  active: boolean;

  /**
   * First day the store has a price snapshot (`YYYY-MM-DD`), or null when it
   * has none yet. The client uses it to annotate "store added" steps on
   * aggregate charts.
   */
  firstDate: string | null;

  /**
   * Last day the store has a price snapshot (`YYYY-MM-DD`), or null when it
   * has none yet.
   */
  lastDate: string | null;

  /**
   * Listings ever recorded for the store, whatever their stock state.
   */
  listings: number;

  /**
   * Listings currently flagged in stock.
   */
  inStockListings: number;
}

export interface DashboardMeta {
  /**
   * Earliest day with any snapshot data (`YYYY-MM-DD`), or null on an empty
   * database. Range requests are clamped to it server-side; the client greys
   * out anything earlier.
   */
  dataFloorDate: string | null;

  /**
   * Latest day with any snapshot data (`YYYY-MM-DD`), or null on an empty
   * database.
   */
  latestDate: string | null;

  /**
   * Distinct capture days present in the snapshot table.
   */
  dayCount: number;

  /**
   * Per-store coverage, for legends, filters and store-added annotations.
   */
  stores: DashboardStoreCoverage[];
}

export interface DashboardMetric {
  /**
   * Value on the last day with data inside the requested range, or null when
   * the range holds no data.
   */
  latest: number | null;

  /**
   * Value on the first day with data inside the requested range, or null
   * when the range holds no data.
   */
  baseline: number | null;

  /**
   * `latest - baseline`, or null when either side is null.
   */
  delta: number | null;

  /**
   * Delta as a percentage of the baseline, or null when the baseline is null
   * or zero.
   */
  deltaPct: number | null;
}

export interface DashboardSummary {
  /**
   * Resolved (possibly clamped) inclusive range start (`YYYY-MM-DD`).
   */
  from: string;

  /**
   * Resolved (possibly clamped) inclusive range end (`YYYY-MM-DD`).
   */
  to: string;

  /**
   * First day inside the range that actually has data, or null when none do.
   * Frequently later than `from` — the range boundary is not always a data
   * day.
   */
  baselineDate: string | null;

  /**
   * Last day inside the range that actually has data, or null when none do.
   */
  latestDate: string | null;

  /**
   * Listings in stock (one price snapshot per listing per day).
   */
  inStockListings: DashboardMetric;

  /**
   * Listings known by the day (`firstSeen <= day`), whatever their stock
   * state — the out-of-stock denominator.
   */
  trackedListings: DashboardMetric;

  /**
   * Derived out-of-stock listings: `max(0, tracked - inStock)`. See
   * `DashboardMetricsUtils.deriveOos` for the exact semantics and caveats.
   */
  oosListings: DashboardMetric;

  /**
   * Distinct canonical bottlings with at least one in-stock listing.
   */
  distinctProducts: DashboardMetric;

  /**
   * Distinct brands among the in-stock listings (unbranded products are not
   * counted).
   */
  distinctBrands: DashboardMetric;

  /**
   * Median in-stock price, UAH.
   */
  medianPrice: DashboardMetric;

  /**
   * Fraction (0..1) of in-stock listings flagged as a genuine promo.
   */
  promoShare: DashboardMetric;

  /**
   * Stores with at least one in-stock listing that day.
   */
  activeStores: DashboardMetric;
}

export interface DashboardSeriesPoint {
  /**
   * Bucket day (`YYYY-MM-DD`); the bucket's first day when weekly.
   */
  date: string;

  /**
   * Listings in stock that day (snapshot rows).
   */
  inStockListings: number;

  /**
   * Listings known by that day (`firstSeen <= day`).
   */
  trackedListings: number;

  /**
   * Derived out-of-stock listings, `max(0, tracked - inStock)`. Biased low
   * on the very first data days (retention boundary) and includes listings
   * that were silently delisted — the schema cannot tell the two apart.
   */
  oosListings: number;

  /**
   * Distinct canonical bottlings priced that day.
   */
  distinctProducts: number;

  /**
   * Distinct brands among that day's in-stock listings.
   */
  distinctBrands: number;

  /**
   * Stores with at least one in-stock listing that day. Always 1 inside a
   * per-store series.
   */
  activeStores: number;

  /**
   * Median in-stock price that day (UAH), or null when nothing was priced.
   */
  medianPrice: number | null;

  /**
   * 25th price percentile (UAH), or null when nothing was priced.
   */
  p25Price: number | null;

  /**
   * 75th price percentile (UAH), or null when nothing was priced.
   */
  p75Price: number | null;

  /**
   * In-stock listings flagged as a genuine promo that day.
   */
  promoListings: number;

  /**
   * Listings first seen that day (flow; summed in weekly buckets).
   */
  newListings: number;

  /**
   * Listings last seen that day that are now out of stock (flow; summed in
   * weekly buckets). Structurally 0 on the latest day — a departure is only
   * knowable once a later sync misses the listing.
   */
  departedListings: number;
}

export interface DashboardStoreSeries {
  /**
   * Store slug the series belongs to.
   */
  storeSlug: string;

  /**
   * Human-readable store name.
   */
  name: string;

  /**
   * Brand color configured for the store, or null.
   */
  color: string | null;

  /**
   * The store's per-day points, ascending by date.
   */
  points: DashboardSeriesPoint[];
}

export interface DashboardCountrySeries {
  /**
   * ISO country code, or `unknown` for products without a country.
   */
  countryCode: string;

  /**
   * Ukrainian country name; falls back to the code for the `unknown` bucket.
   */
  nameUa: string;

  /**
   * Flag emoji/icon for the country, or null.
   */
  icon: string | null;

  /**
   * The country's per-day points, ascending by date.
   */
  points: DashboardSeriesPoint[];
}

export interface DashboardSeries {
  /**
   * Resolved (possibly clamped) inclusive range start (`YYYY-MM-DD`).
   */
  from: string;

  /**
   * Resolved (possibly clamped) inclusive range end (`YYYY-MM-DD`).
   */
  to: string;

  /**
   * Bucketing actually applied to the returned points.
   */
  granularity: DashboardGranularity;

  /**
   * The all-stores (or `stores`-scoped) series, ascending by date. Not
   * derivable from the partitioned series — distinct counts and medians do
   * not compose across partitions.
   */
  total: DashboardSeriesPoint[];

  /**
   * Per-store series when `byStore` was requested, otherwise empty.
   */
  byStore: DashboardStoreSeries[];

  /**
   * Per-country series when `byCountry` was requested, otherwise empty.
   */
  byCountry: DashboardCountrySeries[];
}

export interface DashboardBreakdownBucket {
  /**
   * Bucket identity: a type/flavor name, a store slug, an ISO country code,
   * a price-bucket ordinal key, or `unknown` for null dimensions. Display
   * labels are the client's job — never UI text here.
   */
  key: string;

  /**
   * In-stock listings in the bucket on the sliced day.
   */
  listings: number;

  /**
   * Distinct canonical bottlings in the bucket on the sliced day.
   */
  products: number;

  /**
   * Median in-stock price inside the bucket (UAH), or null when empty.
   */
  medianPrice: number | null;

  /**
   * Lower price bound of a price bucket (UAH); null for the open bottom
   * bucket and for non-price dimensions.
   */
  minPrice: number | null;

  /**
   * Upper price bound of a price bucket (UAH); null for the open top bucket
   * and for non-price dimensions.
   */
  maxPrice: number | null;
}

export interface DashboardBreakdown {
  /**
   * Dimension the assortment was sliced by.
   */
  by: DashboardBreakdownBy;

  /**
   * Capture day the slice describes (`YYYY-MM-DD`) — echoed because an
   * absent/future request date resolves to the latest captured day.
   */
  date: string;

  /**
   * True when one product may fall into several buckets (flavors), so the
   * bucket shares do not sum to one and must not be rendered as parts of a
   * whole.
   */
  overlapping: boolean;

  /**
   * In-stock listings on the sliced day, across all buckets.
   */
  totalListings: number;

  /**
   * Distinct in-stock bottlings on the sliced day.
   */
  totalProducts: number;

  /**
   * The buckets, largest first (price buckets keep price order).
   */
  buckets: DashboardBreakdownBucket[];
}

export interface DashboardMover {
  /**
   * Store-offer id — what `/report/history` takes.
   */
  storeProductId: ID;

  /**
   * Canonical product id, for deep links to the product view.
   */
  productId: ID;

  /**
   * Canonical product name, or null when the bottling has none.
   */
  name: string | null;

  /**
   * Raw scraped listing name.
   */
  nameOrig: string;

  /**
   * Slug of the store quoting the price.
   */
  storeSlug: string;

  /**
   * Name of the store quoting the price.
   */
  storeName: string;

  /**
   * Day of the first snapshot inside the range (`YYYY-MM-DD`) — may be later
   * than the range start when the listing appeared mid-range.
   */
  firstDate: string;

  /**
   * Day of the last snapshot inside the range (`YYYY-MM-DD`) — may be
   * earlier than the range end when the listing went out of stock.
   */
  lastDate: string;

  /**
   * Price on `firstDate`, UAH.
   */
  firstPrice: number;

  /**
   * Price on `lastDate`, UAH.
   */
  lastPrice: number;

  /**
   * `lastPrice - firstPrice`, UAH (negative for drops).
   */
  changeAbs: number;

  /**
   * Change as a percentage of `firstPrice` (negative for drops).
   */
  changePct: number;

  /**
   * Price currency code.
   */
  currency: string;
}

export interface DashboardMovers {
  /**
   * Resolved (possibly clamped) inclusive range start (`YYYY-MM-DD`).
   */
  from: string;

  /**
   * Resolved (possibly clamped) inclusive range end (`YYYY-MM-DD`).
   */
  to: string;

  /**
   * Largest price drops, most negative `changePct` first.
   */
  drops: DashboardMover[];

  /**
   * Largest price rises, most positive `changePct` first.
   */
  rises: DashboardMover[];
}

export interface DashboardSyncDay {
  /**
   * Calendar day of the runs (`YYYY-MM-DD`, from the run's start time).
   */
  date: string;

  /**
   * Sync runs started that day.
   */
  runs: number;

  /**
   * Runs that finished successfully.
   */
  succeeded: number;

  /**
   * Runs that finished with an error.
   */
  failed: number;

  /**
   * Runs still open (no outcome yet) — non-zero only for the current day
   * while a sync is in flight.
   */
  running: number;

  /**
   * New SKUs stored across the day's runs.
   */
  added: number;

  /**
   * Listings flagged out of stock across the day's runs. Attributed to the
   * run's day — one day after the listing's own `lastSeen`.
   */
  removed: number;

  /**
   * Listings refreshed across the day's runs.
   */
  updated: number;

  /**
   * Items the scrapers saw in listings that day, including out-of-stock
   * items that persist skips — deliberately not named `total`, because it is
   * not `added + updated`.
   */
  itemsSeen: number;

  /**
   * Mean finished-run duration that day (ms), or null when nothing finished.
   */
  avgDurationMs: number | null;

  /**
   * Longest finished-run duration that day (ms), or null when nothing
   * finished.
   */
  maxDurationMs: number | null;
}

export interface DashboardSyncActivity {
  /**
   * Inclusive range start the activity was computed for (`YYYY-MM-DD`).
   */
  from: string;

  /**
   * Inclusive range end the activity was computed for (`YYYY-MM-DD`).
   */
  to: string;

  /**
   * One entry per day that had runs, ascending by date.
   */
  days: DashboardSyncDay[];
}

export interface DashboardDailyRow {
  /**
   * Capture day (`YYYY-MM-DD`).
   */
  date: string;

  /**
   * Snapshot rows that day — in-stock listings.
   */
  inStockListings: number;

  /**
   * Distinct bottlings priced that day.
   */
  distinctProducts: number;

  /**
   * Distinct brands among that day's listings.
   */
  distinctBrands: number;

  /**
   * Stores with at least one snapshot that day.
   */
  activeStores: number;

  /**
   * 25th price percentile (UAH), or null on an empty day.
   */
  p25Price: number | null;

  /**
   * Median price (UAH), or null on an empty day.
   */
  medianPrice: number | null;

  /**
   * 75th price percentile (UAH), or null on an empty day.
   */
  p75Price: number | null;

  /**
   * Snapshots flagged as a genuine promo that day.
   */
  promoListings: number;
}

export interface DashboardDailyStoreRow extends DashboardDailyRow {
  /**
   * Slug of the store the row belongs to.
   */
  storeSlug: string;

  /**
   * Name of the store the row belongs to.
   */
  storeName: string;

  /**
   * Configured store color, or null.
   */
  storeColor: string | null;
}

export interface DashboardDailyCountryRow extends DashboardDailyRow {
  /**
   * ISO country code, or `unknown` for products without a country.
   */
  countryCode: string;

  /**
   * Ukrainian country name; equals the code for the `unknown` bucket.
   */
  countryName: string;

  /**
   * Flag icon for the country, or null.
   */
  countryIcon: string | null;
}

export interface DashboardLifecycleRow {
  /**
   * Calendar day (`YYYY-MM-DD`).
   */
  date: string;

  /**
   * Listings with `firstSeen <= day` — known by that day.
   */
  trackedListings: number;

  /**
   * Listings whose `firstSeen` is exactly that day.
   */
  newListings: number;

  /**
   * Out-of-stock listings whose `lastSeen` is exactly that day.
   */
  departedListings: number;
}

export interface DashboardLifecycleGroupRow extends DashboardLifecycleRow {
  /**
   * Partition key the row belongs to: a store slug or a country code.
   */
  key: string;
}

export interface DashboardBreakdownRow {
  /**
   * Raw bucket key from SQL: a dimension value or a numeric `width_bucket`
   * index (as text) for price buckets.
   */
  key: string;

  /**
   * In-stock listings in the bucket.
   */
  listings: number;

  /**
   * Distinct bottlings in the bucket.
   */
  products: number;

  /**
   * Median price inside the bucket (UAH), or null.
   */
  medianPrice: number | null;
}

export interface DashboardCaptureBounds {
  /**
   * Earliest capture day (`YYYY-MM-DD`), or null on an empty table.
   */
  floor: string | null;

  /**
   * Latest capture day (`YYYY-MM-DD`), or null on an empty table.
   */
  latest: string | null;

  /**
   * Distinct capture days present.
   */
  dayCount: number;
}
