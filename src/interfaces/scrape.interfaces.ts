import { ID } from './entity.interfaces';

/**
 * A normalized product ready to be written to the `product` table. Lookup
 * names have already been resolved to FK ids, and both the raw and cleaned
 * names are precomputed by the caller — the repository only writes.
 */
export interface ProductUpsertInput {
  /**
   * Owning store id.
   */
  storeId: ID;

  /**
   * Store-side SKU; unique per store, drives the upsert conflict target.
   */
  sku: string;

  /**
   * Product page URL.
   */
  url: string;

  /**
   * Raw scraped name, refreshed on every sync.
   */
  nameOrig: string;

  /**
   * Cleaned display name. Written once on insert and never overwritten, so
   * manual edits survive later scrapes.
   */
  name: string;

  /**
   * Resolved brand id, or null when the brand could not be determined. Merged
   * with COALESCE on conflict so a later null never clears a known brand.
   */
  brandId: ID | null;

  /**
   * Resolved whisky-type id, or null. Written once on insert only.
   */
  typeId: ID | null;

  /**
   * Resolved country id, or null. Written once on insert only.
   */
  countryId: ID | null;

  /**
   * Age statement in years, or null. Written once on insert only.
   */
  age: number | null;

  /**
   * Alcohol by volume percent, or null. Written once on insert only.
   */
  abv: number | null;

  /**
   * Volume in millilitres, or null. Written once on insert only.
   */
  volumeMl: number | null;

  /**
   * The sync's capture day (`YYYY-MM-DD`): used for `firstSeen` on insert and
   * `lastSeen` on every write.
   */
  seenOn: string;
}

/**
 * Result of a single product upsert.
 */
export interface ProductUpsertResult {
  /**
   * The product id (existing or freshly inserted).
   */
  id: ID;

  /**
   * True when this call inserted a new product, false when it updated an
   * existing one. Derived from `xmax = 0`; intended for run counters, not
   * correctness-critical branching.
   */
  isNew: boolean;
}

/**
 * The mutable price fields of a single day's snapshot.
 */
export interface PriceSnapshotUpsertInput {
  /**
   * Current price.
   */
  price: number;

  /**
   * Strike-through / previous price, or null when there is none.
   */
  oldPrice: number | null;

  /**
   * ISO currency code.
   */
  currency: string;

  /**
   * Whether the product is in stock.
   */
  inStock: boolean;

  /**
   * Whether the current price is a promo.
   */
  promo: boolean;
}
