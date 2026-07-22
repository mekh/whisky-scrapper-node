import { ID } from './entity.interfaces';

/**
 * Request body for a manual product edit. Every field except `id` is optional;
 * an omitted (undefined) field is left unchanged, while `null` clears it.
 */
export interface ProductUpdateInput {
  /**
   * Id of the product to update.
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
