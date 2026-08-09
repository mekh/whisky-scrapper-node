import { ID } from './entity.interfaces';

/**
 * One product as a store's scrape adapter produces it, before it is resolved
 * and written. The adapter fills the raw fields (name, price, ...); the
 * normalizer fills `volumeMl`/`abv`/`ageYears`/`whiskyType`/`country`/
 * `flavorTags` when the site did not provide them. Fields are mutated in place
 * through the pipeline, mirroring the Python `ProductSnapshot`.
 */
export interface ProductSnapshot {
  /**
   * Slug of the store this item came from.
   */
  storeSlug: string;

  /**
   * The store's own SKU / identifier for the item.
   */
  storeSku: string;

  /**
   * Product page URL.
   */
  url: string;

  /**
   * Raw product name as scraped.
   */
  name: string;

  /**
   * Brand + expression extracted from `name` by the LLM pass, or absent when
   * that pass is disabled, skipped (existing SKU) or rejected the result.
   * The persist step falls back to `ProductNameUtils.clean(name)`.
   */
  cleanName?: string | null;

  /**
   * Current price.
   */
  price: number;

  /**
   * Brand as scraped or canonicalized, or null when unknown.
   */
  brand: string | null;

  /**
   * Strike-through / previous price, or null when there is none.
   */
  oldPrice: number | null;

  /**
   * ISO currency code (defaults to UAH).
   */
  currency: string;

  /**
   * Whether the store reports the item as in stock.
   */
  inStock: boolean;

  /**
   * Whether the current price is a promo.
   */
  promo: boolean;

  /**
   * Volume in millilitres, or null when unknown.
   */
  volumeMl: number | null;

  /**
   * Alcohol by volume percent, or null when unknown.
   */
  abv: number | null;

  /**
   * Age statement in years, or null when unknown.
   */
  ageYears: number | null;

  /**
   * Whisky type (single malt / blend / ...), or null when unknown.
   */
  whiskyType: string | null;

  /**
   * Ukrainian country name; resolved to a country id at write time.
   */
  country: string | null;

  /**
   * Flavor tags extracted for the item.
   */
  flavorTags: string[];

  /**
   * Extra scraped attributes (description, category, ...) searched during
   * normalization. Not persisted.
   */
  rawAttrs: Record<string, unknown>;
}

/**
 * The store-specific fields an adapter provides when building a snapshot; the
 * base fills `storeSlug` and the defaults for everything omitted.
 */
export type ScrapeItemInput =
  & Pick<ProductSnapshot, 'storeSku' | 'url' | 'name' | 'price'>
  & Partial<
    Omit<
      ProductSnapshot,
      'storeSlug' | 'storeSku' | 'url' | 'name' | 'price'
    >
  >;

/**
 * The scrape configuration an adapter needs: the store row joined with its
 * `store_config`, including the politeness delay bounds.
 */
export interface StoreScrapeSpec {
  /**
   * Store slug.
   */
  slug: string;

  /**
   * Store display name.
   */
  name: string;

  /**
   * Store root URL.
   */
  baseUrl: string;

  /**
   * Scrape tier (1 = HTTP, 2 = Magento, 3 = browser).
   */
  tier: number;

  /**
   * Whether scraping needs a headless browser.
   */
  needsBrowser: boolean;

  /**
   * Zakaz.ua retail-chain slug, when applicable.
   */
  retailChain: string | null;

  /**
   * Zakaz.ua category slug, when applicable.
   */
  category: string | null;

  /**
   * Lower bound of the per-request politeness delay, in seconds.
   */
  delayFrom: number;

  /**
   * Upper bound of the per-request politeness delay, in seconds.
   */
  delayTo: number;
}

/**
 * A progress event emitted while a store is being collected. The orchestrator
 * turns these into `sync_log` progress touches.
 */
export type ScrapeProgressEvent =
  | {
    /**
     * A listing page finished.
     */
    kind: 'page';

    /**
     * 1-based page number.
     */
    page: number;

    /**
     * New items parsed on this page.
     */
    added: number;

    /**
     * Running total of parsed items.
     */
    total: number;
  }
  | {
    /**
     * The full listing finished.
     */
    kind: 'fetched';

    /**
     * Total items returned.
     */
    found: number;

    /**
     * How many were in stock.
     */
    inStock: number;
  }
  | {
    /**
     * Detail-enrichment progress.
     */
    kind: 'enrich';

    /**
     * How many items have been enriched so far.
     */
    done: number;

    /**
     * How many items need enrichment in total.
     */
    pending: number;
  };

/**
 * Sink for scrape progress events.
 */
export type ScrapeProgressReporter = (event: ScrapeProgressEvent) => void;

/**
 * One store's scrape session.
 */
export interface ScrapeAdapter {
  /**
   * The store slug this adapter serves.
   */
  readonly slug: string;

  /**
   * Whether the adapter can fetch product detail pages for fields missing from
   * the listing.
   */
  readonly supportsDetail: boolean;

  /**
   * Fetches the store's whole whisky listing as raw snapshots.
   *
   * @returns The scraped items.
   */
  fetchListing(): Promise<ProductSnapshot[]>;

  /**
   * Fills a snapshot's empty fields from its product detail page.
   *
   * @param snap - The snapshot to enrich (mutated in place).
   * @returns True when the detail page was fetched and parsed.
   */
  enrichDetail(snap: ProductSnapshot): Promise<boolean>;

  /**
   * Waits out the store's jittered politeness delay. The adapter paces its own
   * listing pagination; this exposes the same delay to the detail-enrichment
   * loop, which the engine drives.
   *
   * @returns Resolves once the delay has elapsed.
   */
  sleep(): Promise<void>;

  /**
   * Releases the adapter's resources (HTTP client, browser).
   *
   * @returns Resolves once everything is closed.
   */
  close(): Promise<void>;
}

/**
 * Resolves the right adapter for a store, hiding tier/HTTP-strategy/browser
 * details from the orchestrator.
 */
export interface ScrapeAdapterFactory {
  /**
   * Builds the adapter for a store.
   *
   * @param spec - The store's scrape configuration.
   * @param reporter - Optional progress sink passed to the adapter.
   * @returns The adapter.
   */
  create(
    spec: StoreScrapeSpec,
    reporter?: ScrapeProgressReporter,
  ): ScrapeAdapter;
}

/**
 * Options for a single store collection.
 */
export interface CollectOptions {
  /**
   * When true, scrape and normalize but write nothing to the database (used by
   * the parity harness).
   */
  dryRun?: boolean;

  /**
   * Optional progress sink.
   */
  reporter?: ScrapeProgressReporter;
}

/**
 * The outcome of collecting one store.
 */
export interface SiteResult {
  /**
   * Store slug.
   */
  slug: string;

  /**
   * How many items the adapter returned (before the stock split).
   */
  found: number;

  /**
   * How many in-stock items were written (or would be, in a dry run).
   */
  stored: number;

  /**
   * How many of the stored items were new (not previously in the database).
   */
  added: number;

  /**
   * How many products were marked out of stock (rows are kept, never
   * deleted).
   */
  removed: number;

  /**
   * The normalized in-stock snapshots. Populated in a dry run for comparison;
   * omitted after a real write.
   */
  items?: ProductSnapshot[];
}

/**
 * A normalized product ready to be written to the `product` table. Lookup
 * names have already been resolved to FK ids, and both the raw and cleaned
 * names are precomputed by the caller — the repository only writes.
 */
export interface ProductUpsertInput {
  /**
   * Owning store id.
   */
  storeId: ID;

  /**
   * Store-side SKU; unique per store, drives the upsert conflict target.
   */
  sku: string;

  /**
   * Product page URL.
   */
  url: string;

  /**
   * Raw scraped name, refreshed on every sync.
   */
  nameOrig: string;

  /**
   * Cleaned display name, or null when nothing meaningful remains. Written once
   * on insert and never overwritten, so manual edits survive later scrapes.
   */
  name: string | null;

  /**
   * Resolved brand id, or null when the brand could not be determined. Merged
   * with COALESCE on conflict so a later null never clears a known brand.
   */
  brandId: ID | null;

  /**
   * Resolved whisky-type id, or null. Written once on insert only.
   */
  typeId: ID | null;

  /**
   * Resolved country id, or null. Written once on insert only.
   */
  countryId: ID | null;

  /**
   * Age statement in years, or null. Written once on insert only.
   */
  age: number | null;

  /**
   * Alcohol by volume percent, or null. Written once on insert only.
   */
  abv: number | null;

  /**
   * Volume in millilitres, or null. Written once on insert only.
   */
  volumeMl: number | null;

  /**
   * The sync's capture day (`YYYY-MM-DD`): used for `firstSeen` on insert and
   * `lastSeen` on every write.
   */
  seenOn: string;
}

/**
 * Result of a single product upsert.
 */
export interface ProductUpsertResult {
  /**
   * The product id (existing or freshly inserted).
   */
  id: ID;

  /**
   * True when this call inserted a new product, false when it updated an
   * existing one. Derived from `xmax = 0`; intended for run counters, not
   * correctness-critical branching.
   */
  isNew: boolean;
}

/**
 * The mutable price fields of a single day's snapshot.
 */
export interface PriceSnapshotUpsertInput {
  /**
   * Current price.
   */
  price: number;

  /**
   * Strike-through / previous price, or null when there is none.
   */
  oldPrice: number | null;

  /**
   * ISO currency code.
   */
  currency: string;

  /**
   * Whether the product is in stock.
   */
  inStock: boolean;

  /**
   * Whether the current price is a promo.
   */
  promo: boolean;
}
