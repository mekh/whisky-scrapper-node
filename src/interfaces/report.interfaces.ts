import { ReportKind, ReportSortField, ReportWindow, SortOrder } from '~enums';

import { ID } from './entity.interfaces';

export interface ReportKindParams {
  /**
   * Which report to run.
   */
  kind: ReportKind;
}

export interface HistoryQuery {
  /**
   * Product id or a name/URL substring to resolve the product by.
   */
  term: string;
}

export interface ReportOptions {
  /**
   * Window used by the `low` report and the `drops` reference lookback. For the
   * `new` report, `today`/`yesterday` instead narrow listings to that added-on
   * day; any other value keeps the whole "new" window.
   */
  window: ReportWindow;

  /**
   * Minimum whole-percent discount a row must have (applied to reports that
   * compute a discount). Undefined means no minimum.
   */
  minDiscount?: number;

  /**
   * Field to sort the full result by before pagination. Undefined keeps the
   * report's natural order.
   */
  sort?: ReportSortField;

  /**
   * Sort direction when `sort` is set.
   */
  order: SortOrder;

  /**
   * One-based page number.
   */
  page: number;

  /**
   * Page size.
   */
  perPage: number;
}

export interface ReportQuery {
  /**
   * Store slugs to include (CSV in the query string).
   */
  stores?: string[];

  /**
   * Inclusive lower price bound.
   */
  minPrice?: number;

  /**
   * Inclusive upper price bound.
   */
  maxPrice?: number;

  /**
   * Inclusive lower volume bound (ml).
   */
  minVolume?: number;

  /**
   * Inclusive upper volume bound (ml).
   */
  maxVolume?: number;

  /**
   * Flavor names the product must have at least one of (CSV).
   */
  flavors?: string[];

  /**
   * Flavor names the product must have none of (CSV).
   */
  excludeFlavors?: string[];

  /**
   * Whisky type names to include; `unknown` matches typeless products (CSV).
   */
  types?: string[];

  /**
   * ISO country codes to include (CSV).
   */
  countries?: string[];

  /**
   * Minimum whole-percent discount for discount-bearing reports.
   */
  minDiscount?: number;

  /**
   * Case-insensitive product-name substring.
   */
  name?: string;

  /**
   * Report window for `low` and the `drops` reference lookback. For the `new`
   * report, `today`/`yesterday` narrow listings to that added-on day.
   */
  window?: ReportWindow;

  /**
   * Field to sort the full result by before pagination.
   */
  sort?: ReportSortField;

  /**
   * Sort direction.
   */
  order?: SortOrder;

  /**
   * One-based page number.
   */
  page?: number;

  /**
   * Page size (must be one of the allowed options).
   */
  perPage?: number;
}

export interface ReportFilter {
  /**
   * Store slugs to include. Empty/undefined means every store.
   */
  stores?: string[];

  /**
   * Inclusive lower bound on the current price. Undefined means no bound.
   */
  minPrice?: number;

  /**
   * Inclusive upper bound on the current price. Undefined means no bound.
   */
  maxPrice?: number;

  /**
   * Inclusive lower bound on bottle volume in millilitres.
   */
  minVolume?: number;

  /**
   * Inclusive upper bound on bottle volume in millilitres.
   */
  maxVolume?: number;

  /**
   * Flavor names the product must carry at least one of.
   */
  flavors?: string[];

  /**
   * Flavor names the product must carry none of.
   */
  excludeFlavors?: string[];

  /**
   * Whisky type names to match; the literal `unknown` matches products that
   * have no type. Empty/undefined means every type.
   */
  types?: string[];

  /**
   * ISO country codes (case-insensitive) to include.
   */
  countries?: string[];

  /**
   * Case-insensitive substring the product name must contain.
   */
  name?: string;
}

export interface ReportCurrentRow {
  /**
   * Product id (uuid v7).
   */
  id: ID;

  /**
   * Store-specific product SKU.
   */
  sku: string;

  /**
   * Absolute URL of the product page.
   */
  url: string;

  /**
   * Cleaned display name, or `null` when cleaning left nothing usable.
   */
  name: string | null;

  /**
   * Raw product name exactly as scraped; the display fallback for `name`.
   */
  nameOrig: string;

  /**
   * Age statement in years, when known.
   */
  age: number | null;

  /**
   * Alcohol by volume in percent, when known.
   */
  abv: number | null;

  /**
   * Bottle volume in millilitres, when known.
   */
  volumeMl: number | null;

  /**
   * Slug of the store offering the product.
   */
  storeSlug: string;

  /**
   * Display name of the store offering the product.
   */
  storeName: string;

  /**
   * Brand name, when resolved.
   */
  brand: string | null;

  /**
   * Whisky type name, when resolved.
   */
  type: string | null;

  /**
   * ISO country code, when resolved.
   */
  countryCode: string | null;

  /**
   * Ukrainian country name, when resolved.
   */
  countryName: string | null;

  /**
   * Country flag emoji, when resolved.
   */
  countryIcon: string | null;

  /**
   * Current price from the latest snapshot.
   */
  price: number;

  /**
   * Store strike-through/reference price from the latest snapshot, if any.
   */
  oldPrice: number | null;

  /**
   * Currency code of the prices.
   */
  currency: string;

  /**
   * Whether the latest snapshot reported the product in stock.
   */
  inStock: boolean;

  /**
   * Whether the latest snapshot was flagged as a promo.
   */
  promo: boolean;

  /**
   * Price from the immediately preceding snapshot, if any.
   */
  previousPrice: number | null;

  /**
   * Capture date (`YYYY-MM-DD`) of the latest snapshot.
   */
  capturedDate: string;

  /**
   * Date (`YYYY-MM-DD`) the product was first seen.
   */
  firstSeen: string;

  /**
   * Flavor names attached to the product (sorted, possibly empty).
   */
  flavors: string[];
}

export interface ReportRow extends ReportCurrentRow {
  /**
   * Reference price the discount is measured against (report-specific: the
   * previous observed price, the window maximum from our history, or the
   * competing offer). Always sourced from prices we actually recorded, never
   * the store's advertised strike price (`oldPrice`). Null when there is no
   * meaningful discount.
   */
  referencePrice: number | null;

  /**
   * Whole-percent discount of `price` against `referencePrice`, or null.
   */
  discountPct: number | null;

  /**
   * Whether the product is within the "new listing" window.
   */
  isNew: boolean;

  /**
   * Days since the product first appeared (0 = today), when applicable.
   */
  daysNew: number | null;
}

export interface PriceHistoryPoint {
  /**
   * Capture date of the snapshot (`YYYY-MM-DD`).
   */
  date: string;

  /**
   * Price recorded on that date.
   */
  price: number;
}

export interface PriceHistory {
  /**
   * The resolved product with its latest-vs-previous pricing.
   */
  product: ReportRow;

  /**
   * Chronological price points, oldest first.
   */
  series: PriceHistoryPoint[];
}
