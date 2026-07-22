export interface MetaStore {
  /**
   * Store slug (stable identifier used in filters).
   */
  slug: string;

  /**
   * Store display name.
   */
  name: string;

  /**
   * Scrape tier (1 = HTTP, 2 = Magento, 3 = browser).
   */
  tier: number;

  /**
   * Whether scraping the store needs a headless browser.
   */
  needsBrowser: boolean;

  /**
   * Brand color for the UI, when set.
   */
  color: string | null;

  /**
   * Whether the store is currently active.
   */
  active: boolean;
}

export interface MetaCountry {
  /**
   * ISO country code (filter value).
   */
  code: string;

  /**
   * Ukrainian country name (display).
   */
  nameUa: string;

  /**
   * Country flag emoji, when set.
   */
  icon: string | null;
}

export interface Meta {
  /**
   * Stores available for filtering, in insertion order.
   */
  stores: MetaStore[];

  /**
   * Distinct flavor names available as filter chips.
   */
  flavors: string[];

  /**
   * Distinct whisky type names available as filter chips.
   */
  types: string[];

  /**
   * Countries present in the catalog (code + display).
   */
  countries: MetaCountry[];

  /**
   * All countries (code + display), for edit dropdowns — a superset of
   * `countries`, which is limited to those referenced by a product.
   */
  allCountries: MetaCountry[];

  /**
   * Supported report window keys (`week`/`month`/`year`).
   */
  windows: string[];

  /**
   * Allowed page sizes for report pagination.
   */
  perPageOptions: number[];

  /**
   * Default page size when none is requested.
   */
  defaultPerPage: number;
}
