import { Inject, Injectable, Logger } from '@nestjs/common';

import { SCRAPE_ADAPTER_FACTORY } from '~constants';
import { CoreBrandService } from '~core/brand';
import { CoreProductService } from '~core/product';
import { CoreStoreService } from '~core/store';
import { CoreStoreConfigService } from '~core/store-config';
import { NotFoundError, ServerError } from '~errors';
import type {
  CollectOptions,
  ID,
  ProductSnapshot,
  ScrapeAdapter,
  ScrapeAdapterFactory,
  ScrapeProgressReporter,
  SiteResult,
  StoreListItem,
  StoreScrapeSpec,
} from '~types';
import { ErrorUtils, ProductNameUtils } from '~utils';

import { LlmEnrichmentService } from './llm/llm-enrichment.service';
import { LlmFlavorService } from './llm/llm-flavor.service';
import { LlmNameExtractionService } from './llm/llm-name-extraction.service';
import { NormalizeService } from './normalize/normalize.service';
import { ScrapePersistService } from './persist/scrape-persist.service';

const ENRICH_PROGRESS_EVERY = 10;

/**
 * Collects a single store: resolve its adapter, fetch and normalize the
 * listing, split in-stock from out-of-stock, run the LLM fallback, then either
 * persist (real run) or return the items untouched (dry run). A faithful port
 * of the Python `collect_site`, minus the removed exclude-flavors filter.
 */
@Injectable()
export class ScrapeService {
  /**
   * Groups snapshots by the resolved name persist will store them under, so one
   * bottling is classified once however many SKUs of it this store lists. Two
   * volumes of the same whisky are two SKUs but one flavor profile, and asking
   * twice both pays twice and risks the two rows disagreeing.
   *
   * A snapshot whose name resolves to null matches nothing and stays a group of
   * its own.
   *
   * @param pending - Snapshots awaiting classification.
   * @param keys - Each snapshot's resolved name, from the caller's lookup map.
   * @returns One group per distinct name, each headed by the snapshot to
   *   actually send to the model.
   */
  private static groupByFlavorKey(
    pending: ProductSnapshot[],
    keys: Map<ProductSnapshot, string | null>,
  ): ProductSnapshot[][] {
    const named = new Map<string, ProductSnapshot[]>();
    const nameless: ProductSnapshot[][] = [];

    pending.forEach((snap) => {
      const key = keys.get(snap);

      if (key === null || key === undefined) {
        nameless.push([snap]);

        return;
      }

      const group = named.get(key);

      if (group) {
        group.push(snap);

        return;
      }

      named.set(key, [snap]);
    });

    return [...named.values(), ...nameless];
  }

  /**
   * Copies each group head's answer onto the siblings that share its name. An
   * unanswered head is copied too — the whole group then stays unchecked and is
   * asked about again next run, rather than half of it recording a miss.
   *
   * @param groups - Groups as built by {@link groupByFlavorKey}.
   */
  private static fanOutFlavors(groups: ProductSnapshot[][]): void {
    groups.forEach(([head, ...siblings]) => {
      siblings.forEach((snap) => {
        snap.llmFlavorTags = head.llmFlavorTags
          ? [...head.llmFlavorTags]
          : undefined;
        snap.llmFlavorConfidence = head.llmFlavorConfidence;
        snap.llmFlavorChecked = head.llmFlavorChecked;
      });
    });
  }

  private readonly logger = new Logger(ScrapeService.name);

  private readonly stores: CoreStoreService;

  private readonly storeConfigs: CoreStoreConfigService;

  private readonly products: CoreProductService;

  private readonly brands: CoreBrandService;

  private readonly adapters: ScrapeAdapterFactory;

  private readonly normalizer: NormalizeService;

  private readonly llm: LlmEnrichmentService;

  private readonly llmNames: LlmNameExtractionService;

  private readonly llmFlavor: LlmFlavorService;

  private readonly persist: ScrapePersistService;

  public constructor(
    stores: CoreStoreService,
    storeConfigs: CoreStoreConfigService,
    products: CoreProductService,
    brands: CoreBrandService,
    @Inject(SCRAPE_ADAPTER_FACTORY) adapters: ScrapeAdapterFactory,
    normalizer: NormalizeService,
    llm: LlmEnrichmentService,
    llmNames: LlmNameExtractionService,
    llmFlavor: LlmFlavorService,
    persist: ScrapePersistService,
  ) {
    this.stores = stores;
    this.storeConfigs = storeConfigs;
    this.products = products;
    this.brands = brands;
    this.adapters = adapters;
    this.normalizer = normalizer;
    this.llm = llm;
    this.llmNames = llmNames;
    this.llmFlavor = llmFlavor;
    this.persist = persist;
  }

  /**
   * Collects one store by slug.
   *
   * @param slug - Store slug.
   * @param options - Dry-run and backfill flags, optional progress reporter.
   * @returns The collection outcome.
   * @throws {NotFoundError} When no store has the slug.
   * @throws {ServerError} When the store has no scrape configuration.
   */
  public async collectStore(
    slug: string,
    options: CollectOptions = {},
  ): Promise<SiteResult> {
    const store = await this.stores.findWithConfigBySlug(slug);

    if (!store) {
      throw new NotFoundError('Store not found', { slug });
    }

    const backfill = options.backfill ?? false;
    const spec = await this.buildSpec(store);
    const brandNames = await this.brands.listNames();
    const brandIndex = this.normalizer.buildBrandIndex(brandNames);

    const snaps = await this.scrape(
      spec,
      store.id,
      backfill,
      options.reporter,
    );

    snaps.forEach((snap) => this.normalizer.normalize(snap, brandIndex));

    const found = snaps.length;
    const inStock = snaps.filter((snap) => snap.inStock);
    const outOfStock = snaps.filter((snap) => !snap.inStock);

    options.reporter?.({
      kind: 'fetched',
      found,
      inStock: inStock.length,
    });

    const { llmDeadline } = options;

    await this.runLlm(inStock, backfill, options.reporter, llmDeadline);

    /**
     * Both remaining passes only ever act on SKUs this store has never stored,
     * so they share one lookup.
     */
    const known = await this.products.existingSkus(store.id);

    await this.runNameExtraction(
      known,
      inStock,
      options.reporter,
      llmDeadline,
    );
    await this.runFlavorEnrichment(
      known,
      inStock,
      options.reporter,
      llmDeadline,
    );

    if (options.dryRun) {
      return {
        slug,
        found,
        stored: inStock.length,
        added: 0,
        removed: 0,
        items: inStock,
      };
    }

    const capturedOn = new Date().toISOString().slice(0, 10);
    const counts = await this.persist.persist(
      store.id,
      inStock,
      outOfStock.map((snap) => snap.storeSku),
      capturedOn,
      backfill,
      options.reporter,
    );

    return { slug, found, ...counts };
  }

  /**
   * Builds the adapter spec from the store list item plus its delay bounds.
   *
   * @param store - The store list item (id + joined config).
   * @returns The scrape spec.
   * @throws {ServerError} When the store has no scrape configuration.
   */
  private async buildSpec(store: StoreListItem): Promise<StoreScrapeSpec> {
    const config = await this.storeConfigs.findOne({ storeId: store.id });

    if (!config || store.tier === null) {
      throw new ServerError('Store has no scrape configuration', {
        slug: store.slug,
      });
    }

    return {
      slug: store.slug,
      name: store.name,
      baseUrl: store.baseUrl,
      tier: store.tier,
      needsBrowser: store.needsBrowser ?? false,
      retailChain: store.retailChain,
      category: store.category,
      delayFrom: config.delayFrom,
      delayTo: config.delayTo,
    };
  }

  /**
   * Runs the adapter: fetch the listing and, for detail-capable adapters,
   * enrich items missing an ABV. The adapter is always closed.
   *
   * @param spec - The scrape spec.
   * @param storeId - The store id (for the detail-fetch gate).
   * @param backfill - Whether the wider backfill detail gate applies.
   * @param reporter - Optional progress reporter.
   * @returns The raw scraped snapshots.
   */
  private async scrape(
    spec: StoreScrapeSpec,
    storeId: ID,
    backfill: boolean,
    reporter?: ScrapeProgressReporter,
  ): Promise<ProductSnapshot[]> {
    const adapter = this.adapters.create(spec, reporter);

    try {
      const snaps = await adapter.fetchListing();

      if (adapter.supportsDetail && snaps.length > 0) {
        await this.enrichDetails(adapter, storeId, snaps, backfill, reporter);
      }

      return snaps;
    } finally {
      await adapter.close();
    }
  }

  /**
   * Fetches detail pages for items whose stored fields are still incomplete,
   * pacing the requests with the store's politeness delay. One failing item
   * does not stop the rest. A normal run only chases a missing ABV; a backfill
   * run also chases a missing volume, type or country.
   *
   * @param adapter - The store adapter.
   * @param storeId - The store id.
   * @param snaps - The scraped snapshots.
   * @param backfill - Whether the wider backfill detail gate applies.
   * @param reporter - Optional progress reporter.
   * @returns Resolves once enrichment is done.
   */
  private async enrichDetails(
    adapter: ScrapeAdapter,
    storeId: ID,
    snaps: ProductSnapshot[],
    backfill: boolean,
    reporter?: ScrapeProgressReporter,
  ): Promise<void> {
    const complete = backfill
      ? await this.products.skusWithCoreDetails(storeId)
      : await this.products.skusWithAbv(storeId);

    const pending = snaps.filter((snap) => !complete.has(snap.storeSku));

    if (!pending.length) {
      return;
    }

    let done = 0;

    for (const snap of pending) {
      try {
        await adapter.enrichDetail(snap);
      } catch (error) {
        this.logger.warn('Detail fetch failed for %s: %o', snap.url, error);
        reporter?.({
          kind: 'detail-failed',
          url: snap.url,
          error: ErrorUtils.text(error),
        });
      }

      done += 1;

      if (done % ENRICH_PROGRESS_EVERY === 0 || done === pending.length) {
        reporter?.({ kind: 'enrich', done, pending: pending.length });
      }

      await adapter.sleep();
    }
  }

  /**
   * Runs the LLM fallback for in-stock items still missing key fields, when
   * enabled. A backfill run also asks about a missing type or country, which a
   * normal run leaves to the deterministic pass — for a new row those columns
   * can still be filled by the next run, but a stored row would keep the gap
   * forever. Age stays out of the trigger: a bottling without an age statement
   * legitimately has none, so it would make every run ask about the same items.
   *
   * @param inStock - In-stock snapshots.
   * @param backfill - Whether the wider backfill trigger applies.
   * @param reporter - Optional progress reporter.
   * @param signal - Optional LLM deadline.
   * @returns Resolves once enrichment has been attempted.
   */
  private async runLlm(
    inStock: ProductSnapshot[],
    backfill: boolean,
    reporter?: ScrapeProgressReporter,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.llm.enabled) {
      return;
    }

    const pending = inStock.filter((snap) =>
      this.normalizer.needsLlm(snap)
      || (backfill && (snap.whiskyType === null || snap.country === null))
    );

    if (!pending.length) {
      return;
    }

    if (this.outOfLlmBudget('fields', pending.length, reporter, signal)) {
      return;
    }

    reporter?.({ kind: 'llm', pass: 'fields', pending: pending.length });

    await this.llm.enrich(pending, signal);
  }

  /**
   * Extracts the brand + expression display name for the items this store has
   * never stored before. Known SKUs are skipped: `product.name` is written
   * once on insert, so re-extracting it could never be persisted.
   *
   * @param known - SKUs the store has already stored.
   * @param inStock - In-stock snapshots.
   * @param reporter - Optional progress reporter.
   * @param signal - Optional LLM deadline.
   * @returns Resolves once extraction has been attempted.
   */
  private async runNameExtraction(
    known: Set<string>,
    inStock: ProductSnapshot[],
    reporter?: ScrapeProgressReporter,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.llmNames.enabled || !inStock.length) {
      return;
    }

    const pending = inStock.filter((snap) => !known.has(snap.storeSku));

    if (!pending.length) {
      return;
    }

    if (this.outOfLlmBudget('names', pending.length, reporter, signal)) {
      return;
    }

    reporter?.({ kind: 'llm', pass: 'names', pending: pending.length });

    await this.llmNames.extractNames(pending, undefined, signal);
  }

  /**
   * Fills in the flavor profile of the items this store has never stored
   * before, reusing an answer already recorded for the same bottling and
   * calling the model only for the rest.
   *
   * Known SKUs are skipped outright: their answer is already stored, and a
   * bottling's flavor does not change between runs. The name lookup then covers
   * the case a SKU gate cannot — a bottling this store is listing for the first
   * time but another store already carries. Most of the catalogue is in that
   * position, so without it a new listing would both pay for a redundant call
   * and risk coming back with different tags than the sibling row, leaving one
   * product tagged two ways depending on which store you looked at.
   *
   * @param known - SKUs the store has already stored.
   * @param inStock - In-stock snapshots.
   * @param reporter - Optional progress reporter.
   * @param signal - Optional LLM deadline.
   * @returns Resolves once classification has been attempted.
   */
  private async runFlavorEnrichment(
    known: Set<string>,
    inStock: ProductSnapshot[],
    reporter?: ScrapeProgressReporter,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.llmFlavor.enabled || !inStock.length) {
      return;
    }

    const fresh = inStock.filter((snap) => !known.has(snap.storeSku));

    if (!fresh.length) {
      return;
    }

    /**
     * Keyed on the name persist will store, so a hit here is a hit on the row
     * that would be written. A snapshot whose name resolves to null cannot be
     * matched and goes straight to the model.
     */
    const keys = new Map(
      fresh.map((snap) => [
        snap,
        ProductNameUtils.resolve(snap.cleanName, snap.name),
      ]),
    );

    const stored = await this.products.findLlmFlavorsByNames([
      ...new Set([...keys.values()].filter((key): key is string => !!key)),
    ]);

    const pending = fresh.filter((snap) => {
      const key = keys.get(snap);
      const tags = key === null || key === undefined
        ? undefined
        : stored.get(key);

      if (!tags) {
        return true;
      }

      /**
       * `llmFlavorConfidence` stays unset: the stored links do not record what
       * the model claimed when it produced them, and inventing a value here
       * would misreport it. `llmFlavorChecked` is what persist gates on.
       */
      snap.llmFlavorTags = [...tags].sort();
      snap.llmFlavorChecked = true;

      return false;
    });

    this.logger.debug(
      'Flavor pass: %d of %d new SKU(s) reused a stored answer',
      fresh.length - pending.length,
      fresh.length,
    );

    if (!pending.length) {
      return;
    }

    const groups = ScrapeService.groupByFlavorKey(pending, keys);

    this.logger.debug(
      'Flavor pass: %d new SKU(s) cover %d distinct name(s)',
      pending.length,
      groups.length,
    );

    if (this.outOfLlmBudget('flavors', groups.length, reporter, signal)) {
      return;
    }

    reporter?.({ kind: 'llm', pass: 'flavors', pending: groups.length });

    await this.llmFlavor.classify(
      groups.map((group) => group[0]),
      undefined,
      signal,
    );

    ScrapeService.fanOutFlavors(groups);
  }

  /**
   * Whether an LLM pass has to be skipped because the run's LLM budget is
   * already spent, reporting the skip when it does.
   *
   * @param pass - Which pass is being considered.
   * @param pending - How many items it would have asked about.
   * @param reporter - Optional progress reporter.
   * @param signal - Optional LLM deadline.
   * @returns True when the pass must not run.
   */
  private outOfLlmBudget(
    pass: 'fields' | 'names' | 'flavors',
    pending: number,
    reporter?: ScrapeProgressReporter,
    signal?: AbortSignal,
  ): boolean {
    if (signal?.aborted !== true) {
      return false;
    }

    this.logger.warn(
      'LLM %s pass skipped: the run is out of LLM budget (%d item(s) left)',
      pass,
      pending,
    );
    reporter?.({ kind: 'llm-deadline', pass, pending });

    return true;
  }
}
