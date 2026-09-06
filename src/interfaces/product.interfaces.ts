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
 * Moves one store offer onto another bottling, leaving the rest of its group
 * where it is.
 *
 * This is the correction for a listing the matcher filed under the wrong
 * whisky — a shop's `Arran 10yo` set that is really an `Arran Amarone Cask`.
 * `POST /product/update` cannot express it: every field there belongs to the
 * bottling and so applies to every store at once.
 *
 * The target is named in one of two ways. `productId` picks an existing
 * bottling outright. Without it the attribute fields describe the bottling
 * the offer should belong to, and the server looks it up by identity — the
 * name, volume and age — relinking to the row it finds and **creating one
 * only when nothing matches**; a hand-typed correction must not mint a second
 * row for a whisky the catalogue already holds.
 */
export interface ProductRelinkInput {
  /**
   * The store-offer id to move. A canonical product id is refused here: the
   * whole point is to act on one listing rather than on the group.
   */
  id: ID;

  /**
   * The bottling to move the offer onto. When present, every other field is
   * ignored.
   */
  productId?: ID | null;

  /**
   * Display name of the bottling the offer belongs to. Required when
   * `productId` is absent — a bottling nothing can name cannot be found or
   * created.
   */
  name?: string | null;

  /**
   * ISO country code of a bottling to create; ignored when an existing one
   * is found.
   */
  countryCode?: string | null;

  /**
   * Whisky type name of a bottling to create; ignored when an existing one
   * is found.
   */
  typeName?: string | null;

  /**
   * Age statement in years, or `null` for a NAS bottling. Part of the
   * identity the lookup matches on.
   */
  age?: number | null;

  /**
   * Alcohol by volume of a bottling to create; ignored when an existing one
   * is found — strength is deliberately no part of a bottling's identity.
   */
  abv?: number | null;

  /**
   * Bottle volume in millilitres. Part of the identity the lookup matches on.
   */
  volumeMl?: number | null;

  /**
   * Flavor tags for a bottling to create, by name; ignored when an existing
   * one is found, whose own tags stand.
   */
  flavors?: string[];
}

/**
 * What a manual edit or a relink answers with: the id the client asked about,
 * and the bottling that id now belongs to, since either operation may have
 * changed it.
 */
export interface TypeProduct {
  /**
   * The id the request named — a store offer or a canonical product — echoed
   * back so the response still names the thing the client asked about.
   */
  id: ID;

  /**
   * The bottling the request left the offer (or the product) on. Differs from
   * the bottling the client knew when an edit folded two rows into one, or
   * when a relink moved the offer; the client re-reads by offer id, so it can
   * treat this as informational.
   */
  productId: ID;

  /**
   * Cleaned / manually edited display name of that bottling, or `null` when
   * unset.
   */
  name: string | null;

  /**
   * Raw scraped name of the offer; the display fallback for `name`.
   */
  nameOrig: string;

  /**
   * True when the operation folded the edited bottling into another that
   * turned out to be the same whisky: same name, volume and age. The edited
   * row is gone and `productId` names the survivor.
   */
  merged: boolean;

  /**
   * True when a relink had to create the bottling because nothing in the
   * catalogue matched the attributes it was given.
   */
  created: boolean;
}
