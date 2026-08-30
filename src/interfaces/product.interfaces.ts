import { ID } from './entity.interfaces';

/**
 * One store's offer resolved back to the bottling it is for. The report hands
 * out offer ids, while every editable field lives on the canonical product, so
 * the write paths resolve one to the other through this.
 */
export interface StoreProductRef {
  /**
   * The store-offer id.
   */
  id: ID;

  /**
   * The canonical product the offer is for.
   */
  productId: ID;

  /**
   * The offer's raw scraped name, which the canonical row does not carry.
   */
  nameOrig: string;
}

/**
 * The column patch a manual edit builds, holding each edited fact together
 * with its provenance column (`countryId` and `countrySource`, and so on).
 *
 * Keyed loosely because the two halves are assembled from a `ProductFactField`
 * at runtime; the pairing itself is enforced in one place, by the helper that
 * writes both at once, so no caller can set a value and forget its source.
 */
export type ProductManualPatch = Record<string, string | number | null>;

/**
 * Request body for a manual product edit. Every field except `id` is optional;
 * an omitted (undefined) field is left unchanged, while `null` clears it.
 */
export interface ProductUpdateInput {
  /**
   * Id of the product to update. Accepts either a report row's id (a store
   * offer) or a canonical product id; both resolve to the same bottling, and
   * the edit applies to every store listing it.
   */
  id: ID;

  /**
   * New display name; `null` clears it (display falls back to `nameOrig`).
   */
  name?: string | null;

  /**
   * ISO country code to set; `null` clears the country.
   */
  countryCode?: string | null;

  /**
   * Whisky type name to set; `null` clears the type.
   */
  typeName?: string | null;

  /**
   * Age statement in years (positive integer); `null` clears it.
   */
  age?: number | null;

  /**
   * Alcohol by volume in percent (0–96, one decimal); `null` clears it.
   */
  abv?: number | null;

  /**
   * Bottle volume in millilitres (positive integer); `null` clears it.
   */
  volumeMl?: number | null;

  /**
   * The bottling's whole flavor set, by name, as a person chose it. Every name
   * must already exist in the `flavor` reference table — the client picks from
   * the list `/meta` publishes — and an empty array means "no tags at all".
   *
   * Providing this marks the bottling curated, which locks the keyword and LLM
   * passes out of its tags for good; otherwise the next sync would put back
   * whatever the listing still spells out and undo a removal.
   */
  flavors?: string[];
}

/**
 * Minimal product view returned after a manual edit.
 */
export interface TypeProduct {
  /**
   * Product id (uuid v7).
   */
  id: ID;

  /**
   * Cleaned / manually edited display name, or `null` when unset.
   */
  name: string | null;

  /**
   * Raw scraped name; the display fallback for `name`.
   */
  nameOrig: string;
}
