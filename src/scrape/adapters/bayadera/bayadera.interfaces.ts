/**
 * The JSON blob a listing card's buy button carries in `data-product-info` —
 * the analytics payload the site pushes to its dataLayer, and the most
 * reliable source of the card's fields (the rendered text only duplicates
 * it). Apostrophes inside arrive as `'` JSON escapes, so a plain
 * `JSON.parse` of the decoded attribute is safe.
 */
export interface BayaderaProductInfo {
  /**
   * Store article code (`1WS-WGM070-050`); the preferred SKU.
   */
  article?: string | null;

  /**
   * The store's own numeric product id; the SKU fallback.
   */
  id?: number | string | null;

  /**
   * Full product name (`Віскі Glenmorangie The Original 12 YO 0.7л`).
   */
  name?: string | null;

  /**
   * Current (post-discount) price in integer kopecks (199900 = 1999 UAH).
   */
  price?: number | null;

  /**
   * Root-relative product page path (`/product/...`).
   */
  link?: string | null;

  /**
   * Displayed pack size (`0.7 л`); the volume source — gift sets aside, the
   * name repeats it anyway.
   */
  volume?: string | null;

  /**
   * Brand, sometimes prefixed with the category word (`Віскі Glenmorangie`
   * vs a clean `Johnnie Walker`).
   */
  brand?: string | null;

  /**
   * Displayed characteristic values, unlabeled: volume, colour, country,
   * strength (`40%`), flavour notes, pack count — searched by the keyword
   * pass for country and flavors.
   */
  attributes?: (string | null)[] | null;
}
