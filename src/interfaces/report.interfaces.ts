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
   * Narrows the `drops` report to prices that took effect on a given day:
   * `today`/`yesterday` keep only those, any other value (or undefined) keeps
   * every discount. Separate from `window`, which the report already spends on
   * its price-reference lookback.
   */
  discountWindow?: ReportWindow;

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
   * Keep only the caller's favorited bottlings. Their blacklist is applied
   * either way and cannot be switched off from the query string.
   */
  favoritesOnly?: boolean;

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
   * Case-insensitive substring matched against both the cleaned name and the
   * raw scraped one, so descriptors that only survive in `nameOrig` (type,
   * region, packaging) stay searchable. A trailing number is additionally
   * read as an age statement (`Glenfiddich 12`), which is what reaches the
   * bottlings whose name carries no age.
   */
  name?: string;

  /**
   * Report window for `low` and the `drops` reference lookback. For the `new`
   * report, `today`/`yesterday` narrow listings to that added-on day.
   */
  window?: ReportWindow;

  /**
   * Narrows the `drops` report by when the current price took effect:
   * `today`/`yesterday` keep only those drops, anything else keeps them all.
   */
  discountWindow?: ReportWindow;

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
   * The user the report is being run for. Required, and deliberately not
   * optional: it is what the blacklist and favorites predicates key on, so a
   * caller that forgot it would silently serve one user an unfiltered
   * catalogue.
   */
  userId: ID;

  /**
   * When true, keep only bottlings this user has favorited. The blacklist
   * predicates are unconditional and are not expressed here at all.
   */
  favoritesOnly?: boolean;

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
   * Case-insensitive substring the cleaned or the raw product name must
   * contain, or — when the term ends in a number — a name part plus the age
   * that number states (`Glenfiddich 12` also matches every 12-year-old
   * Glenfiddich). Both readings match; see `findCurrentRows`.
   */
  name?: string;

  /**
   * Keep only bottlings whose producer sits in one of these regions, by the
   * market convention.
   */
  regions?: string[];

  /**
   * Drop bottlings whose producer sits in one of these regions.
   *
   * The exclusion is the useful half. "Everything except Islay" is how a
   * peat-averse drinker actually shops, and it is the same shape as
   * `excludeFlavors`, which exists for the same reason.
   */
  excludeRegions?: string[];

  /**
   * Keep only bottlings whose type **and** country both come from a source the
   * filters trust.
   *
   * Opt-in, because it is stricter than the default: the default already
   * refuses to *match* an untrusted value, while this refuses to show the
   * bottling at all. It is for a user who would rather see a short, certain
   * list than a long one with unverified entries in it.
   */
  verifiedFacts?: boolean;
}

export interface ReportCurrentRow {
  /**
   * Store-offer id (uuid v7): one row per store × SKU. This is what the web
   * deep-links and the history endpoint use, and it survived the split of the
   * catalogue out of the store rows unchanged.
   */
  id: ID;

  /**
   * Canonical product id (uuid v7): the bottling this row is an offer of.
   * Several stores' rows share it, which is what groups the `best` report and
   * what a manual edit writes to.
   */
  productId: ID;

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
   * Whether the product is currently in stock at its store. List reads only
   * ever return in-stock rows; the history endpoint can report `false`.
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

  /**
   * The resolved distillery's display name, or null when the knowledge base
   * could not place the bottling.
   */
  distillery: string | null;

  /**
   * The distillery's region, by the market convention rather than the legal
   * one — Talisker reads `islands` here and is legally Highland.
   */
  region: string | null;

  /**
   * The independent bottler's name when there is one. A non-null value is the
   * IB flag: there is no separate boolean.
   */
  bottler: string | null;

  /**
   * Where each of the bottling's facts came from, so the client can mark an
   * unverified one instead of presenting a model's guess as fact.
   */
  factSources: Record<string, string | null>;
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

  /**
   * Days since the current (discounted) price took effect — i.e. how long the
   * price has not been higher than it is now (0 = it dropped today). Set only
   * for the `drops` report; null everywhere else.
   */
  daysDiscount: number | null;
}

/**
 * One store's offer inside a report group: the fields that differ between the
 * offers of the same bottling. Everything a group's offers share — the name,
 * age, ABV, volume, brand, type, country and flavors — lives on the group
 * itself, so it is stated once per product instead of once per store.
 *
 * Derived from `ReportRow` rather than declared beside it: the two must not be
 * able to disagree about what an offer's price or discount means, and the
 * picked fields keep their documentation.
 */
export type ReportOffer = Pick<
  ReportRow,
  | 'id'
  | 'sku'
  | 'url'
  | 'nameOrig'
  | 'storeSlug'
  | 'storeName'
  | 'price'
  | 'oldPrice'
  | 'currency'
  | 'promo'
  | 'inStock'
  | 'previousPrice'
  | 'referencePrice'
  | 'discountPct'
  | 'isNew'
  | 'daysNew'
  | 'daysDiscount'
  | 'firstSeen'
  | 'capturedDate'
>;

export interface ReportGroup extends ReportRow {
  /**
   * The offers of this bottling the report selected, cheapest first and never
   * empty. Which offers those are depends on the kind: `catalog` and `best`
   * hold every in-stock offer, while `new` and `drops` hold only the offers
   * that qualified (newly listed / discounted), so a product added by two
   * stores lists exactly those two. `low` keeps its per-offer selection and
   * therefore carries a single offer.
   *
   * `best` is the one kind whose offers can fall outside the requested price
   * bounds: they are what its winner is compared against, and the item's
   * `referencePrice` already quotes the runner-up. An offer-level
   * `discountPct` is always that offer's own price move, except on `best`'s
   * winning offer, which carries the item's saving against the runner-up.
   *
   * Every field the group itself carries is the first offer's — the cheapest
   * one — which is what the collapsed row shows and what an offer-level sort
   * orders by. A store may legitimately appear twice (two SKUs of one
   * bottling, say a boxed and a plain listing), so this counts offers, never
   * stores.
   */
  offers: ReportOffer[];
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
