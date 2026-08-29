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
   * Scotland's regions, by the **market convention** — the six a shop and a
   * drinker use, `islands` included. This is what a filter chip should offer.
   *
   * It is deliberately not the legal list: Talisker, Highland Park, Tobermory,
   * Jura and Arran are all legally Highland and are listed by every shop as
   * island malts, so a filter built on the legal five would answer a question
   * nobody asked. The label the client renders has to say so — "region
   * (common)" rather than a bare "region".
   */
  regions: string[];

  /**
   * The five protected SWA regions, for display and for anyone who wants the
   * legal answer. `islands` is not among them and never can be.
   */
  legalRegions: string[];

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
