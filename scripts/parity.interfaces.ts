/**
 * One snapshot as the Python scraper serializes it (snake_case dataclass).
 */
export interface PythonSnapshot {
  /**
   * Store slug.
   */
  store_slug: string;

  /**
   * Store-side SKU.
   */
  store_sku: string;

  /**
   * Product page URL.
   */
  url: string;

  /**
   * Raw product name.
   */
  name: string;

  /**
   * Current price.
   */
  price: number;

  /**
   * Brand, or null.
   */
  brand: string | null;

  /**
   * Strike-through price, or null.
   */
  old_price: number | null;

  /**
   * Currency code.
   */
  currency: string;

  /**
   * Whether the item is in stock.
   */
  in_stock: boolean;

  /**
   * Whether the price is a promo.
   */
  promo: boolean;

  /**
   * Volume in millilitres, or null.
   */
  volume_ml: number | null;

  /**
   * ABV percent, or null.
   */
  abv: number | null;

  /**
   * Age statement in years, or null.
   */
  age_years: number | null;

  /**
   * Whisky type, or null.
   */
  whisky_type: string | null;

  /**
   * Country name (Ukrainian), or null.
   */
  country: string | null;

  /**
   * Flavor tags.
   */
  flavor_tags: string[];
}

/**
 * The subset of a snapshot both engines are compared on.
 */
export interface ParityItem {
  /**
   * Store-side SKU; the join key.
   */
  sku: string;

  /**
   * Product page URL.
   */
  url: string;

  /**
   * Raw product name.
   */
  name: string;

  /**
   * Current price.
   */
  price: number;

  /**
   * Strike-through price, or null.
   */
  oldPrice: number | null;

  /**
   * Whether the price is a promo.
   */
  promo: boolean;

  /**
   * Brand, or null.
   */
  brand: string | null;

  /**
   * Volume in millilitres, or null.
   */
  volumeMl: number | null;

  /**
   * ABV percent, or null.
   */
  abv: number | null;

  /**
   * Age statement in years, or null.
   */
  ageYears: number | null;

  /**
   * Whisky type, or null.
   */
  whiskyType: string | null;

  /**
   * Country name, or null.
   */
  country: string | null;

  /**
   * Flavor tags, joined for comparison.
   */
  flavorTags: string;
}

/**
 * One field that differs between the two engines for one SKU.
 */
export interface ParityDiff {
  /**
   * The SKU the difference was found on.
   */
  sku: string;

  /**
   * The compared field.
   */
  field: keyof ParityItem;

  /**
   * The Python value.
   */
  python: unknown;

  /**
   * The TypeScript value.
   */
  ts: unknown;
}
