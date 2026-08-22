import { ID } from './entity.interfaces';

/**
 * One user's personal filters over the catalogue: what they want to keep an eye
 * on and what they never want to see again. Read as a whole — the client needs
 * all three lists to render a report row.
 */
export interface Preference {
  /**
   * Canonical product ids the user favorited. These are bottlings
   * (`ReportGroup.productId`), not store offers (`ReportOffer.id`): a favorite
   * is a whisky, so it lights up in every store that carries it.
   */
  favorites: ID[];

  /**
   * Canonical product ids the user hid. Every report kind filters these out,
   * unconditionally and for this user only.
   */
  blacklistProducts: ID[];

  /**
   * Canonical brand names the user hid — names, never ids, in both directions.
   * The client shows and sends what `brand.name` holds, and an unknown name is
   * a bad request rather than a brand to coin.
   */
  blacklistBrands: string[];
}

/**
 * Request shape for adding or removing favorites in bulk.
 */
export interface PreferenceFavoritesInput {
  /**
   * Canonical product ids to add or remove. Adding is idempotent; removing an
   * id that was never a favorite is a no-op. An empty array is accepted and
   * changes nothing, so a client may send whatever selection it holds.
   */
  productIds: ID[];
}

/**
 * Request shape for adding or removing blacklist entries in bulk. Both fields
 * are optional individually, but a request that carries neither is rejected —
 * an empty blacklist call is a mistake, not an instruction.
 */
export interface PreferenceBlacklistInput {
  /**
   * Canonical product ids to hide or unhide.
   */
  productIds?: ID[];

  /**
   * Canonical brand names to hide or unhide, resolved strictly against the
   * `brand` table.
   */
  brands?: string[];
}

/**
 * The resolved, core-level shape of a blacklist change: brand names have
 * already been turned into ids, so the persistence layer never resolves names.
 */
export interface PreferenceBlacklistIds {
  /**
   * Canonical product ids to hide or unhide.
   */
  productIds: ID[];

  /**
   * Brand ids to hide or unhide.
   */
  brandIds: ID[];
}
