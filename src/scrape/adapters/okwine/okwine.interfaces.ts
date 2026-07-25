/**
 * One value of a product characteristic.
 */
export interface OkwineCharacteristicValue {
  /**
   * The value itself (`700 мл`, `21 рік`, ...).
   */
  value?: string | null;
}

/**
 * One characteristic row of a product.
 */
export interface OkwineCharacteristic {
  /**
   * Slug identifying the characteristic (`obiem`, `vytrymka`, ...).
   */
  path?: string | null;

  /**
   * The characteristic's values; only the first one is used.
   */
  values?: OkwineCharacteristicValue[] | null;
}

/**
 * The price block of a product. `min_price` is NOT a retail price (it repeats
 * at ~296.8 across items, apparently a per-100 ml or club figure) and is
 * ignored.
 */
export interface OkwinePrices {
  /**
   * Current retail price, in hryvnia.
   */
  price?: number | null;

  /**
   * Pre-discount price; 0 means there is none.
   */
  old_price?: number | null;
}

/**
 * One product of the OK Wine filter API.
 */
export interface OkwineProduct {
  /**
   * Product id; the preferred SKU.
   */
  id?: string | number | null;

  /**
   * URL slug of the product page; also the SKU fallback.
   */
  url?: string | null;

  /**
   * Product name; carries the ABV and volume.
   */
  name?: string | null;

  /**
   * Price block.
   */
  prices?: OkwinePrices | null;

  /**
   * Whether the item is in stock in the requested city.
   */
  inStock?: boolean;

  /**
   * Characteristic rows (category, volume, age, ...).
   */
  characteristics?: OkwineCharacteristic[] | null;

  /**
   * Meta description, searched during normalization.
   */
  meta_description?: string | null;
}

/**
 * The paginated product block of the filter response.
 */
export interface OkwineProductsData {
  /**
   * Last available page number.
   */
  maxPage?: number | null;

  /**
   * The requested page number.
   */
  page?: number | null;

  /**
   * Products on this page.
   */
  data?: OkwineProduct[] | null;
}

/**
 * The filter API response envelope.
 */
export interface OkwineListing {
  /**
   * Payload wrapper.
   */
  data?: {
    /**
     * The paginated product block.
     */
    productsData?: OkwineProductsData | null;
  } | null;
}
