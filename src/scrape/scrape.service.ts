import { Inject, Injectable, Logger } from '@nestjs/common';

import { SCRAPE_ADAPTER_FACTORY } from '~constants';
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

import { LlmEnrichmentService } from './llm/llm-enrichment.service';
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
  private readonly logger = new Logger(ScrapeService.name);

  private readonly stores: CoreStoreService;

  private readonly storeConfigs: CoreStoreConfigService;

  private readonly products: CoreProductService;

  private readonly adapters: ScrapeAdapterFactory;

  private readonly normalizer: NormalizeService;

  private readonly llm: LlmEnrichmentService;

  private readonly persist: ScrapePersistService;

  public constructor(
    stores: CoreStoreService,
    storeConfigs: CoreStoreConfigService,
    products: CoreProductService,
    @Inject(SCRAPE_ADAPTER_FACTORY) adapters: ScrapeAdapterFactory,
    normalizer: NormalizeService,
    llm: LlmEnrichmentService,
    persist: ScrapePersistService,
  ) {
    this.stores = stores;
    this.storeConfigs = storeConfigs;
    this.products = products;
    this.adapters = adapters;
    this.normalizer = normalizer;
    this.llm = llm;
    this.persist = persist;
  }

  /**
   * Collects one store by slug.
   *
   * @param slug - Store slug.
   * @param options - Dry-run flag and optional progress reporter.
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

    const spec = await this.buildSpec(store);
    const snaps = await this.scrape(spec, store.id, options.reporter);

    snaps.forEach((snap) => this.normalizer.normalize(snap));

    const found = snaps.length;
    const inStock = snaps.filter((snap) => snap.inStock);
    const outOfStock = snaps.filter((snap) => !snap.inStock);

    options.reporter?.({
      kind: 'fetched',
      found,
      inStock: inStock.length,
    });

    await this.runLlm(inStock);

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
   * @param reporter - Optional progress reporter.
   * @returns The raw scraped snapshots.
   */
  private async scrape(
    spec: StoreScrapeSpec,
    storeId: ID,
    reporter?: ScrapeProgressReporter,
  ): Promise<ProductSnapshot[]> {
    const adapter = this.adapters.create(spec, reporter);

    try {
      const snaps = await adapter.fetchListing();

      if (adapter.supportsDetail && snaps.length > 0) {
        await this.enrichDetails(adapter, storeId, snaps, reporter);
      }

      return snaps;
    } finally {
      await adapter.close();
    }
  }

  /**
   * Fetches detail pages for items whose ABV is not already stored (new or
   * incomplete). One failing item does not stop the rest.
   *
   * @param adapter - The store adapter.
   * @param storeId - The store id.
   * @param snaps - The scraped snapshots.
   * @param reporter - Optional progress reporter.
   * @returns Resolves once enrichment is done.
   */
  private async enrichDetails(
    adapter: ScrapeAdapter,
    storeId: ID,
    snaps: ProductSnapshot[],
    reporter?: ScrapeProgressReporter,
  ): Promise<void> {
    const haveAbv = await this.products.skusWithAbv(storeId);
    const pending = snaps.filter((snap) => !haveAbv.has(snap.storeSku));

    if (!pending.length) {
      return;
    }

    let done = 0;

    for (const snap of pending) {
      try {
        await adapter.enrichDetail(snap);
      } catch (error) {
        this.logger.warn('Detail fetch failed for %s: %o', snap.url, error);
      }

      done += 1;

      if (done % ENRICH_PROGRESS_EVERY === 0 || done === pending.length) {
        reporter?.({ kind: 'enrich', done, pending: pending.length });
      }
    }
  }

  /**
   * Runs the LLM fallback for in-stock items still missing key fields, when
   * enabled.
   *
   * @param inStock - In-stock snapshots.
   * @returns Resolves once enrichment has been attempted.
   */
  private async runLlm(inStock: ProductSnapshot[]): Promise<void> {
    if (!this.llm.enabled) {
      return;
    }

    const pending = inStock.filter((snap) => this.normalizer.needsLlm(snap));

    if (pending.length > 0) {
      await this.llm.enrich(pending);
    }
  }
}
