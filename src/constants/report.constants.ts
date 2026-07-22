import { ReportWindow } from '~enums';

// Page sizes the report list offers; the default is the first entry.
export const PER_PAGE_OPTIONS = [50, 100, 150, 200] as const;
export const DEFAULT_PER_PAGE = 50;

// A listing counts as "new" for this many days after its first_seen.
export const NEW_DAYS = 7;

// Day spans backing each report window (drops uses the MONTH span as its
// price-reference lookback). TODAY/YESTERDAY only ever narrow the `new` report
// (by first-seen recency, not a lookback); their spans here just keep the map
// total should a `low`/`drops` request ever carry them.
export const WINDOW_DAYS: Record<ReportWindow, number> = {
  [ReportWindow.TODAY]: 1,
  [ReportWindow.YESTERDAY]: 2,
  [ReportWindow.WEEK]: 7,
  [ReportWindow.MONTH]: 30,
  [ReportWindow.YEAR]: 365,
};

// Windows offered as the `low`/`drops` "minimum period" filter. The `new`
// report's TODAY/YESTERDAY windows are surfaced separately (report toolbar), so
// they are deliberately excluded here.
export const PERIOD_WINDOWS: ReportWindow[] = [
  ReportWindow.WEEK,
  ReportWindow.MONTH,
  ReportWindow.YEAR,
];

// Max price-history points returned by the history endpoint.
export const HISTORY_LIMIT = 60;

// "Best offer" grouping: a product must appear in at least this many stores,
// and a candidate cheaper than this fraction of the runner-up is treated as a
// mismatched SKU rather than a real deal (guards false merges).
export const BEST_MIN_STORES = 2;
export const BEST_MERGE_GUARD = 0.5;

// Sentinel filter value matching products that have no whisky type.
export const UNKNOWN_TYPE = 'unknown';
