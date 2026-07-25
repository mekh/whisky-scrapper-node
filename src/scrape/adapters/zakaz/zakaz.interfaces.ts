/**
 * One physical store in the Zakaz.ua directory (`GET /stores/`). Prices barely
 * differ between a chain's outlets, so the first match wins.
 */
export interface ZakazStore {
  /**
   * Store id used in the listing URL.
   */
  id: string;

  /**
   * The retail chain this outlet belongs to (`metro`, `novus`, ...).
   */
  retail_chain?: string;
}

/**
 * The discount block of a listing item. `old_price` is only meaningful while
 * `status` is true.
 */
export interface ZakazDiscount {
  /**
   * Whether the discount is currently active.
   */
  status?: boolean;

  /**
   * Pre-discount price, in kopecks.
   */
  old_price?: number | null;

  /**
   * Discount size, in percent.
   */
  value?: number | null;
}

/**
 * The producer block of a listing item.
 */
export interface ZakazProducer {
  /**
   * Brand name as the chain records it.
   */
  trademark?: string | null;
}

/**
 * One product of a Zakaz.ua category listing. Prices are in kopecks.
 */
export interface ZakazProduct {
  /**
   * Barcode; the preferred SKU.
   */
  ean?: string | number | null;

  /**
   * Chain-internal article; the SKU fallback.
   */
  sku?: string | number | null;

  /**
   * Product title.
   */
  title?: string | null;

  /**
   * Current price, in kopecks.
   */
  price?: number | null;

  /**
   * Discount block, when the item is on promo.
   */
  discount?: ZakazDiscount | null;

  /**
   * Volume in millilitres.
   */
  volume?: number | null;

  /**
   * Producer block.
   */
  producer?: ZakazProducer | null;

  /**
   * Country of origin, in Ukrainian.
   */
  country?: string | null;

  /**
   * Product page URL; occasionally an explicit null.
   */
  web_url?: string | null;

  /**
   * Whether the chain reports the item as available; a missing flag means
   * available.
   */
  in_stock?: boolean | null;

  /**
   * Marketing description, searched during normalization.
   */
  description?: string | null;
}

/**
 * The category listing response.
 */
export interface ZakazListing {
  /**
   * Products on the requested page.
   */
  results?: ZakazProduct[];
}
