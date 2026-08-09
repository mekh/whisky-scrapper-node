/**
 * One product of the Silpo catalog API.
 */
export interface SilpoProduct {
  /**
   * Product name (`Віскі Jameson`); carries no volume or ABV.
   */
  title?: string | null;

  /**
   * Current price in hryvnia; may be fractional.
   */
  price?: number | null;

  /**
   * Pre-discount price in hryvnia, or null when there is none.
   */
  oldPrice?: number | null;

  /**
   * URL slug of the product page (`viski-jameson-58113`); the SKU fallback.
   */
  slug?: string | null;

  /**
   * The store's own numeric product id, also the slug's trailing segment;
   * the preferred SKU.
   */
  externalProductId?: number | string | null;

  /**
   * Remaining stock of the branch; 0 means out of stock, and out-of-stock
   * items stay in the listing with their price.
   */
  stock?: number | null;

  /**
   * Human-readable pack size the site displays (`0,7л`, `1л`); the volume
   * source.
   */
  displayRatio?: string | null;

  /**
   * Brand name (`Jameson`), or null when the store has none on file.
   */
  brandTitle?: string | null;
}

/**
 * One page of the catalog API response.
 */
export interface SilpoListing {
  /**
   * Total item count of the category, reported on every page.
   */
  total?: number | null;

  /**
   * Products of this page.
   */
  items?: SilpoProduct[] | null;
}
