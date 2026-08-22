import { ID } from './entity.interfaces';

/**
 * Query shape shared by the lightweight autocomplete searches
 * (`GET /product/search`, `GET /brand/search`).
 */
export interface SearchQuery {
  /**
   * The substring to look for, case-insensitive. At least
   * `SEARCH_MIN_LENGTH` characters.
   */
  q: string;

  /**
   * Rows to return at most; the domain service applies
   * `SEARCH_DEFAULT_LIMIT` when absent. Never above `SEARCH_MAX_LIMIT`.
   */
  limit?: number;
}

/**
 * One bottling as the product autocomplete offers it — the minimal set the
 * settings screen needs to render an option and compose a display name.
 * Deliberately not preference-filtered: the picker's job includes finding an
 * already-hidden bottling so it can be un-hidden.
 */
export interface ProductSearchItem {
  /**
   * Canonical product id — the id space the preference API speaks, never a
   * store-offer id.
   */
  productId: ID;

  /**
   * Cleaned display name (brand + expression), or `null` when the catalogue
   * never derived one; display falls back to `nameOrig`.
   */
  name: string | null;

  /**
   * A representative offer's raw scraped name. `null` only for a bottling no
   * store has ever listed.
   */
  nameOrig: string | null;

  /**
   * Canonical brand name, or `null` for a brandless bottling.
   */
  brand: string | null;

  /**
   * Age statement in years, or `null` for NAS bottlings.
   */
  age: number | null;

  /**
   * Alcohol by volume in percent, or `null` when unknown.
   */
  abv: number | null;

  /**
   * Bottle volume in millilitres, or `null` when unknown.
   */
  volumeMl: number | null;

  /**
   * Whether at least one store currently lists the bottling in stock.
   */
  inStock: boolean;
}

export interface NameAgeSearch {
  /**
   * The name part of the term: everything before the trailing number, with
   * the separating whitespace dropped (`Glenfiddich 12` -> `Glenfiddich`).
   * Never empty — a term that is only a number is not split.
   */
  name: string;

  /**
   * The age the trailing number states, in years.
   */
  age: number;
}
