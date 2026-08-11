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

  /**
   * Flavor tags the LLM classification pass returned, already filtered to the
   * closed vocabulary. Empty when the model did not recognize the product.
   * Persisted separately from {@link flavorTags} so a later sync's keyword pass
   * cannot wipe them.
   */
  llmFlavorTags?: string[];

  /**
   * How well the model claimed to know the product. Recorded for diagnostics
   * only — `unknown` already forces {@link llmFlavorTags} empty.
   */
  llmFlavorConfidence?: FlavorConfidence;

  /**
   * Whether the classification pass produced an answer for this item at all.
   * False/absent after a failed batch, which keeps the product's
   * `lastLlmFlavorAt` null so a later run retries it.
   */
  llmFlavorChecked?: boolean;

  /**
   * The bottling this snapshot resolves to (`ProductMatchUtils.key`), computed
   * once the normalization and enrichment passes have settled the name, brand,
   * volume and age. Carried into persist so the key that decided which passes
   * to run is the same one the write looks the product up by. Null when the
   * name yielded no significant word.
   */
  matchKey?: string | null;
}

/**
 * How confident the LLM claimed to be about a product's flavor profile.
 * `unknown` is the required answer for a product the model does not recognize —
 * guessing tags from the name alone is what this exists to prevent.
 */
export type FlavorConfidence = 'high' | 'low' | 'unknown';

/**
 * One stored product read back as flavor-classification input by
 * `CoreProductService.findFlavorCandidates`. Structurally aligned with
 * `LlmFlavorCandidate` (`scrape/llm/llm.interfaces.ts`) plus the id needed to
 * write the answer back, but declared independently because `core/` must not
 * import from `scrape/` — the same split as `ProductSnapshot` and
 * `LlmNameCandidate`.
 *
 * There is deliberately no description field: `rawAttrs` is never persisted, so
 * a stored row offers less grounding than a live scrape does. Expect a higher
 * `unknown` rate from the backfill than from the pipeline pass.
 */
export interface FlavorCandidateRow {
  /**
   * Product id, used to write the resolved flavor links back.
   */
  id: ID;

  /**
   * Raw product name (`product.nameOrig`) — the primary classification input.
   */
  name: string;

  /**
   * Whisky type name when the row has one, as extra grounding.
   */
  whiskyType?: string | null;

  /**
   * Ukrainian country name when the row has one, as extra grounding.
   */
  country?: string | null;

  /**
   * Result slot: the filtered tags the model returned.
   */
  llmFlavorTags?: string[];

  /**
   * Result slot: the confidence the model reported.
   */
  llmFlavorConfidence?: FlavorConfidence;

  /**
   * Result slot: whether the model answered for this item.
   */
  llmFlavorChecked?: boolean;
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
 * turns these into `sync_log` progress touches and into the run's log file
 * lines, which is the only account of what a finished run did.
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
  }
  | {
    /**
     * One item's detail page could not be fetched. The item keeps whatever
     * the listing gave it and the run continues.
     */
    kind: 'detail-failed';

    /**
     * The item's product page URL.
     */
    url: string;

    /**
     * What went wrong, as text.
     */
    error: string;
  }
  | {
    /**
     * Detail enrichment stopped early: the run's soft deadline fired with
     * items still pending. The skipped items keep whatever the listing gave
     * them; a stored row's gaps stay until a backfill run fills them.
     */
    kind: 'detail-deadline';

    /**
     * How many items were enriched before the deadline fired.
     */
    done: number;

    /**
     * How many items needed enrichment in total.
     */
    pending: number;
  }
  | {
    /**
     * An LLM pass is about to run over the items it found pending.
     */
    kind: 'llm';

    /**
     * Which pass: field enrichment, name extraction, or flavor
     * classification.
     */
    pass: 'fields' | 'names' | 'flavors';

    /**
     * How many items the pass will send to the model.
     */
    pending: number;
  }
  | {
    /**
     * An LLM pass was skipped: the run's LLM budget was already spent when it
     * came up. The items keep their gaps and the next run asks about them.
     */
    kind: 'llm-deadline';

    /**
     * Which pass was skipped.
     */
    pass: 'fields' | 'names' | 'flavors';

    /**
     * How many items it would have sent to the model.
     */
    pending: number;
  }
  | {
    /**
     * The store's write transaction committed.
     */
    kind: 'persisted';

    /**
     * How many in-stock items were written.
     */
    stored: number;

    /**
     * How many of them the store had never stored before.
     */
    added: number;

    /**
     * How many bottlings were new to the catalogue, i.e. matched no stored
     * product. Much lower than `added` for a store whose range overlaps the
     * others, and the number to watch when matching changes.
     */
    addedProducts: number;

    /**
     * How many offers were flagged out of stock.
     */
    removed: number;
  }
  | {
    /**
     * The out-of-stock sweep was skipped: this run's in-stock count is low
     * enough against the stored one that the listing looks truncated.
     */
    kind: 'sweep-guarded';

    /**
     * How many items this run saw in stock.
     */
    inStock: number;

    /**
     * How many the store had in stock before the run.
     */
    baseline: number;
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
   * When true, the run repairs the rows it already stored instead of only
   * writing new ones: the upsert fills the columns a normal run leaves alone
   * (name, type, country, age, abv, volume) wherever the stored row is still
   * null, the detail-page gate widens from "has an ABV" to "has ABV, volume,
   * type and country", and the LLM pass also picks up items whose type or
   * country is still missing. A stored value is never overwritten either way.
   * Used by the one-time `backfill-nulls` script; a normal sync leaves it
   * unset and behaves exactly as before.
   */
  backfill?: boolean;

  /**
   * Optional progress sink.
   */
  reporter?: ScrapeProgressReporter;

  /**
   * Deadline for the optional passes — detail enrichment and the LLM passes —
   * ahead of the caller's own timeout. Once it fires, detail enrichment stops
   * fetching and the LLM passes stop asking, and the run goes on to persist
   * what it collected: those passes only fill secondary fields, and losing a
   * scrape that already succeeded to a timeout is far worse than leaving some
   * fields empty.
   */
  deadline?: AbortSignal;
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
 * A canonical bottling ready to be written to the `product` table. Lookup
 * names have already been resolved to FK ids and the match key is precomputed
 * by the caller — the repository only writes.
 */
export interface ProductCanonicalInput {
  /**
   * The cross-store identity (`ProductMatchUtils.key`), or null when the name
   * yielded no significant word. A null key cannot be matched, so such a
   * product is always inserted on its own rather than found.
   */
  matchKey: string | null;

  /**
   * Cleaned display name, or null when nothing meaningful remains. Written
   * once, when the bottling is first seen, so manual edits and the catalogue's
   * chosen spelling survive later scrapes.
   */
  name: string | null;

  /**
   * Resolved brand id, or null when the brand could not be determined.
   */
  brandId: ID | null;

  /**
   * Resolved whisky-type id, or null.
   */
  typeId: ID | null;

  /**
   * Resolved country id, or null.
   */
  countryId: ID | null;

  /**
   * Age statement in years, or null for a NAS bottling. A key component, so it
   * is written at creation and never updated.
   */
  age: number | null;

  /**
   * Alcohol by volume percent, or null.
   */
  abv: number | null;

  /**
   * Volume in millilitres, or null. A key component, so it is written at
   * creation and never updated.
   */
  volumeMl: number | null;
}

/**
 * A fill-if-null patch for one canonical product: the secondary fields a
 * scrape may contribute when the catalogue does not have them yet. Name, age
 * and volume are deliberately absent — the first two are owned by the
 * catalogue, and age and volume are part of the identity.
 */
export interface ProductFillInput {
  /**
   * The canonical product to patch.
   */
  id: ID;

  /**
   * Alcohol by volume percent, or null to contribute nothing.
   */
  abv: number | null;

  /**
   * Resolved brand id, or null to contribute nothing.
   */
  brandId: ID | null;

  /**
   * Resolved whisky-type id, or null to contribute nothing.
   */
  typeId: ID | null;

  /**
   * Resolved country id, or null to contribute nothing.
   */
  countryId: ID | null;
}

/**
 * What the catalogue already knows about a bottling, looked up by match key
 * before the enrichment passes run. A field that is already filled must not be
 * asked about again: the canonical write is fill-if-null, so the answer would
 * be paid for and discarded.
 */
export interface ProductMatchRow {
  /**
   * The canonical product id.
   */
  id: ID;

  /**
   * The key this row was found by.
   */
  matchKey: string;

  /**
   * The stored display name, or null.
   */
  name: string | null;

  /**
   * Stored strength, or null when still unknown.
   */
  abv: number | null;

  /**
   * Stored volume, or null when still unknown.
   */
  volumeMl: number | null;

  /**
   * Stored whisky-type id, or null when still unknown.
   */
  typeId: ID | null;

  /**
   * Stored country id, or null when still unknown.
   */
  countryId: ID | null;

  /**
   * When the flavor pass last answered, or null when it never has.
   */
  lastLlmFlavorAt: Date | null;
}

/**
 * A bottling as the name-cleaning sweep sees it: the stored display name plus
 * one store's raw wording to derive a new one from.
 */
export interface ProductNameCandidateRow {
  /**
   * Canonical product id.
   */
  id: ID;

  /**
   * The stored display name, or null when none was ever derived.
   */
  name: string | null;

  /**
   * A representative store's raw name — the input the cleaning runs over.
   */
  nameOrig: string;

  /**
   * Whether the run's store filter covers this bottling. A filtered run still
   * loads the rest of the catalogue, because the whole-catalogue passes need
   * that evidence, but only rewrites what is carried.
   */
  carried: boolean;
}

/**
 * The fillable fields of a bottling, as carried by one store's SKU. What the
 * backfill audit counts nulls over.
 */
export interface ProductStoreFieldsRow {
  /**
   * The store's SKU for the bottling.
   */
  sku: string;

  /**
   * Age statement in years, or null.
   */
  age: number | null;

  /**
   * Strength, or null.
   */
  abv: number | null;

  /**
   * Volume in millilitres, or null.
   */
  volumeMl: number | null;

  /**
   * Brand id, or null.
   */
  brandId: ID | null;

  /**
   * Whisky-type id, or null.
   */
  typeId: ID | null;

  /**
   * Country id, or null.
   */
  countryId: ID | null;
}

/**
 * One keyword-derived flavor link, written in a single batch per sync.
 */
export interface ProductScrapeFlavorLink {
  /**
   * Canonical product the tag belongs to.
   */
  productId: ID;

  /**
   * The flavor tag.
   */
  flavorId: ID;
}

/**
 * One store's offer, ready to be written to the `store_product` table.
 */
export interface StoreProductUpsertInput {
  /**
   * Owning store id.
   */
  storeId: ID;

  /**
   * The canonical bottling this offer is for, or null when the SKU is already
   * stored. Null means "leave the existing link alone", which is what makes a
   * manual relink survive every later sync.
   */
  productId: ID | null;

  /**
   * Store-side SKU; unique per store, drives the upsert conflict target.
   */
  sku: string;

  /**
   * Product page URL.
   */
  url: string;

  /**
   * Raw scraped name, refreshed on every sync. The store's own wording, kept
   * because its descriptors are what the report's name search matches on.
   */
  nameOrig: string;

  /**
   * The sync's capture day (`YYYY-MM-DD`): used for `firstSeen` on insert and
   * `lastSeen` on every write.
   */
  seenOn: string;
}

/**
 * Result of a single store-offer upsert.
 */
export interface StoreProductUpsertResult {
  /**
   * The offer id (existing or freshly inserted). Price snapshots hang off it.
   */
  id: ID;

  /**
   * The canonical product the offer is linked to, which for a known SKU is
   * whatever the row already pointed at rather than what this run proposed.
   */
  productId: ID;

  /**
   * True when this call inserted a new offer, false when it updated an
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
