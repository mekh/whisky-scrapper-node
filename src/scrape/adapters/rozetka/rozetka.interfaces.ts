import type { ProductSnapshot } from '~types';

/**
 * One catalog tile as the in-page DOM extractor returns it. Prices are parsed
 * in the browser so no raw HTML has to travel back.
 */
export interface RozetkaRow {
  /**
   * Absolute product URL, possibly with a fragment.
   */
  href: string;

  /**
   * Product title, already trimmed.
   */
  title: string;

  /**
   * Current price, or null when the tile shows none. Since 2026-09 the
   * sold-out tail of the listing renders its price slot empty («Залишити
   * відгук» sits where the price was), so a null price is a real tile the
   * store handed over, not a broken one — it merely records nothing.
   */
  price: number | null;

  /**
   * Struck-through previous price, or null when the tile shows none.
   */
  old: number | null;

  /**
   * Whether the tile carries a buy button, which is the store's positive
   * availability marker.
   */
  inStock: boolean;

  /**
   * Whether the tile carries one of the store's known out-of-stock labels.
   * A tile with neither this nor `inStock` is a rendering the extractor does
   * not recognize, and is never treated as a stock signal.
   */
  outOfStock: boolean;
}

/**
 * One rendered listing page as the in-page extractor returns it.
 */
export interface RozetkaPage {
  /**
   * Every catalogue tile the page rendered, priced or not.
   */
  tiles: RozetkaRow[];

  /**
   * The category size the page states above the tiles («Знайдено 2410
   * товарів»), or null when the page carries no such figure.
   */
  stated: number | null;
}

/**
 * What a listing walk has collected so far, carried between the main pass and
 * the re-read of the pages that came back blank.
 */
export interface RozetkaWalk {
  /**
   * The snapshots kept so far, in listing order.
   */
  snaps: ProductSnapshot[];

  /**
   * Every SKU the walk has met, priced or not — a repeated tile is how the
   * walk recognizes the end of the listing.
   */
  seen: Set<string>;

  /**
   * The category size the listing states, or null when no page stated one.
   */
  stated: number | null;

  /**
   * How many tiles the store has handed over, repeats included. It is what
   * the stated size is reconciled against.
   */
  received: number;
}
