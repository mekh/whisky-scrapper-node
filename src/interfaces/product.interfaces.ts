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
