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
   * Current price, or null when the tile shows none.
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
