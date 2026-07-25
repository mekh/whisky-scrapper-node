/**
 * The brand block of a MauDau product.
 */
export interface MaudauBrand {
  /**
   * Brand slug; MauDau exposes no display name in the listing payload.
   */
  slug?: string | null;
}

/**
 * The commercial offer of a MauDau product. Prices are in kopecks.
 */
export interface MaudauOffer {
  /**
   * Current price, in kopecks.
   */
  price?: number | null;

  /**
   * Pre-discount price, in kopecks.
   */
  old_price?: number | null;

  /**
   * Whether the item can be bought right now.
   */
  available?: boolean;

  /**
   * Discount size, in percent.
   */
  discount_percentage?: number | null;
}

/**
 * One product of the MauDau catalog API.
 */
export interface MaudauProduct {
  /**
   * Marketplace-wide product id; the SKU.
   */
  id: string | number;

  /**
   * URL slug of the product page.
   */
  slug: string;

  /**
   * Product title.
   */
  title: string;

  /**
   * Brand block, when the item has one.
   */
  brand?: MaudauBrand | null;

  /**
   * Slug of the product's main category.
   */
  main_category_slug?: string | null;

  /**
   * Offer block; missing prices or availability drop the item.
   */
  offer?: MaudauOffer | null;
}
