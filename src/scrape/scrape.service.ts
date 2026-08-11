import { Inject, Injectable, Logger } from '@nestjs/common';

import { SCRAPE_ADAPTER_FACTORY } from '~constants';
import { CoreBrandService } from '~core/brand';
import { CoreProductService } from '~core/product';
import { CoreStoreService } from '~core/store';
import { CoreStoreConfigService } from '~core/store-config';
import { CoreStoreProductService } from '~core/store-product';
import { NotFoundError, ServerError } from '~errors';
import type {
  CollectOptions,
  ProductMatchRow,
  ProductSnapshot,
  ScrapeAdapter,
  ScrapeAdapterFactory,
  ScrapeProgressReporter,
  SiteResult,
  StoreListItem,
  StoreScrapeSpec,
} from '~types';
import { ErrorUtils } from '~utils';

import type { BrandMatchEntry } from './normalize/normalize.interfaces';

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
   * Groups snapshots by the bottling they resolve to, so one whisky is
   * classified once however many SKUs of it this store lists — a boxed and a
   * plain listing of the same bottle are two SKUs but one flavor profile, and
   * asking twice both pays twice and risks the two answers disagreeing.
   *
   * A snapshot with no match key identifies nothing and stays a group of its
   * own.
   *
   * @param pending - Snapshots awaiting classification.
   * @returns One group per distinct bottling, each headed by the snapshot to
   *   actually send to the model.
   */
  private static groupByFlavorKey(
    pending: ProductSnapshot[],
  ): ProductSnapshot[][] {
    const keyed = new Map<string, ProductSnapshot[]>();
    const unmatchable: ProductSnapshot[][] = [];

    pending.forEach((snap) => {
      const key = snap.matchKey;

      if (key === null || key === undefined) {
        unmatchable.push([snap]);

        return;
      }

      const group = keyed.get(key);

      if (group) {
        group.push(snap);

        return;
      }

      keyed.set(key, [snap]);
    });

    return [...keyed.values(), ...unmatchable];
  }

  /**
   * Whether the catalogue still lacks something a detail page or the model
   * could supply for a bottling.
   *
   * `lastLlmFlavorAt` counts: the detail page is the only source of `rawAttrs`,
   * which is the only grounding the flavor pass ever gets, so a bottling with
   * complete specs but no classification still deserves the fetch.
   *
   * @param row - What the catalogue knows, or undefined when it knows nothing.
   * @returns True when there is something left to fill.
   */
  private static isIncomplete(row: ProductMatchRow | undefined): boolean {
    return row === undefined
      || row.abv === null
      || row.volumeMl === null
      || row.typeId === null
      || row.countryId === null
      || row.lastLlmFlavorAt === null;
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

  private readonly storeProducts: CoreStoreProductService;

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
    storeProducts: CoreStoreProductService,
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
    this.storeProducts = storeProducts;
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
    const { deadline } = options;

    /**
     * Two questions gate every enrichment pass, and they are different
     * questions. "Has this store listed this SKU before?" decides whether the
     * run is looking at something new *to the store* — a stored offer's name
     * and link are written once and never rewritten, so re-deriving them could
     * not be persisted. "Does the catalogue already know this bottling?"
     * decides whether the answer is worth paying for at all: another store may
     * have filled the same fields last week, and the canonical write fills only
     * what is still null, so a second answer would be bought and discarded.
     *
     * The second question is what the split buys. A store onboarding a range
     * the catalogue already covers now skips almost every detail fetch and
     * model call, where before each store paid for its own copy of the same
     * facts.
     */
    const known = await this.storeProducts.existingSkus(store.id);

    const snaps = await this.scrape(
      spec,
      known,
      backfill,
      brandIndex,
      options.reporter,
      deadline,
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

    let canon = await this.loadCanonical(inStock, brandIndex);

    await this.runLlm(
      known,
      inStock,
      canon,
      backfill,
      options.reporter,
      deadline,
    );
    await this.runNameExtraction(
      known,
      inStock,
      canon,
      options.reporter,
      deadline,
    );

    /**
     * The name pass can rewrite `cleanName`, which changes the key — and a
     * rewritten name is exactly the case that turns a miss into a hit, right
     * before the most expensive pass runs.
     */
    canon = await this.loadCanonical(inStock, brandIndex);

    await this.runFlavorEnrichment(
      known,
      inStock,
      canon,
      backfill,
      options.reporter,
      deadline,
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
      options.reporter,
    );

    return { slug, found, ...counts };
  }

  /**
   * Stamps every snapshot with the bottling it resolves to and loads what the
   * catalogue already knows about those bottlings.
   *
   * Called again whenever a pass may have changed a key's inputs. The stamp is
   * carried into persist, so the key that decided what to pay for is the same
   * one the write looks the bottling up by.
   *
   * @param snaps - The snapshots to key (stamped in place, as the rest of this
   *   pipeline does).
   * @param brandIndex - Known brand names, for a snapshot stating none.
   * @returns What the catalogue knows, by match key.
   */
  private async loadCanonical(
    snaps: ProductSnapshot[],
    brandIndex: BrandMatchEntry[],
  ): Promise<Map<string, ProductMatchRow>> {
    snaps.forEach((snap) => {
      snap.matchKey = this.normalizer.matchKey(snap, brandIndex);
    });

    const keys = snaps
      .map((snap) => snap.matchKey)
      .filter((key): key is string => key !== null && key !== undefined);

    return this.products.findByMatchKeys([...new Set(keys)]);
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
   * enrich the items whose fields the run can still persist. The adapter is
   * always closed.
   *
   * @param spec - The scrape spec.
   * @param known - SKUs the store has already stored.
   * @param backfill - Whether the wider backfill detail gate applies.
   * @param brandIndex - Known brand names, for keying the items.
   * @param reporter - Optional progress reporter.
   * @param deadline - Optional soft deadline for the detail pass.
   * @returns The raw scraped snapshots.
   */
  private async scrape(
    spec: StoreScrapeSpec,
    known: Set<string>,
    backfill: boolean,
    brandIndex: BrandMatchEntry[],
    reporter?: ScrapeProgressReporter,
    deadline?: AbortSignal,
  ): Promise<ProductSnapshot[]> {
    const adapter = this.adapters.create(spec, reporter);

    try {
      const snaps = await adapter.fetchListing();

      if (adapter.supportsDetail && snaps.length > 0) {
        const canon = await this.loadCanonical(snaps, brandIndex);

        await this.enrichDetails(
          adapter,
          snaps,
          known,
          canon,
          backfill,
          reporter,
          deadline,
        );
      }

      return snaps;
    } finally {
      await adapter.close();
    }
  }

  /**
   * Fetches detail pages for the items whose fields the run can persist,
   * pacing the requests with the store's politeness delay. One failing item
   * does not stop the rest.
   *
   * Only in-stock items qualify — an out-of-stock item is never upserted, so
   * its detail data has nowhere to go (a store listing its sold-out catalogue
   * used to burn the whole politeness-delay budget on those ghosts). Beyond
   * that, two conditions have to hold: the store must not already list the SKU
   * (a backfill run waives this, which is what lets it re-fetch stored rows),
   * and the catalogue must still be missing something the page could supply.
   *
   * That second condition is the one that changed with the split, and it is
   * where the saving is. The gate used to be per store, so every store paid to
   * discover the same bottling's strength for itself; it is now per bottling,
   * so a store onboarding a range the catalogue already knows fetches almost
   * nothing.
   *
   * The pass also observes the run's soft deadline: it fills secondary fields,
   * so when the budget runs short it stops and the run persists what the
   * listing gave it rather than dying on the store timeout.
   *
   * @param adapter - The store adapter.
   * @param snaps - The scraped snapshots, already keyed.
   * @param known - SKUs the store has already stored.
   * @param canon - What the catalogue knows, by match key.
   * @param backfill - Whether the wider backfill detail gate applies.
   * @param reporter - Optional progress reporter.
   * @param deadline - Optional soft deadline; once it fires the remaining
   *   items are skipped and reported.
   * @returns Resolves once enrichment is done.
   */
  private async enrichDetails(
    adapter: ScrapeAdapter,
    snaps: ProductSnapshot[],
    known: Set<string>,
    canon: Map<string, ProductMatchRow>,
    backfill: boolean,
    reporter?: ScrapeProgressReporter,
    deadline?: AbortSignal,
  ): Promise<void> {
    const pending = snaps.filter((snap) =>
      snap.inStock
      && (backfill || !known.has(snap.storeSku))
      && ScrapeService.isIncomplete(this.stored(snap, canon))
    );

    if (!pending.length) {
      return;
    }

    let done = 0;

    for (const snap of pending) {
      if (deadline?.aborted === true) {
        this.logger.warn(
          'Detail enrichment stopped: out of sync budget, '
            + '%d of %d item(s) skipped',
          pending.length - done,
          pending.length,
        );
        reporter?.({ kind: 'detail-deadline', done, pending: pending.length });

        break;
      }

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
   * enabled.
   *
   * An item is worth asking about only where the snapshot's gap and the
   * catalogue's gap overlap: the canonical write fills what is still null, so
   * an answer for a field the bottling already carries is bought and thrown
   * away. A backfill run waives the "new to this store" half of the gate and
   * additionally chases a missing type or country. Age stays out of the trigger
   * either way — a bottling without an age statement legitimately has none, so
   * including it would make every run ask about the same items forever.
   *
   * @param known - SKUs the store has already stored.
   * @param inStock - In-stock snapshots, already keyed.
   * @param canon - What the catalogue knows, by match key.
   * @param backfill - Whether the wider backfill trigger applies.
   * @param reporter - Optional progress reporter.
   * @param signal - Optional LLM deadline.
   * @returns Resolves once enrichment has been attempted.
   */
  private async runLlm(
    known: Set<string>,
    inStock: ProductSnapshot[],
    canon: Map<string, ProductMatchRow>,
    backfill: boolean,
    reporter?: ScrapeProgressReporter,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.llm.enabled) {
      return;
    }

    const pending = inStock.filter((snap) => {
      if (!backfill && known.has(snap.storeSku)) {
        return false;
      }

      const row = this.stored(snap, canon);

      const wantsField = (snap.abv === null && (row?.abv ?? null) === null)
        || (snap.volumeMl === null && (row?.volumeMl ?? null) === null);

      if (!backfill) {
        return wantsField;
      }

      return wantsField
        || (snap.whiskyType === null && (row?.typeId ?? null) === null)
        || (snap.country === null && (row?.countryId ?? null) === null);
    });

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
   * Extracts the brand + expression display name for listings that would
   * introduce a bottling the catalogue does not have.
   *
   * Both halves of the gate are needed. A SKU the store already lists keeps
   * whatever name it was first given, so a fresh extraction could not be
   * persisted; and a bottling the catalogue already carries already has its
   * name, chosen once for every store.
   *
   * The catalogue's name is deliberately **not** copied onto the snapshot. The
   * key that matched was computed from this listing's own cleaned name, and
   * overwriting it would let the key drift between the gate and the write.
   *
   * @param known - SKUs the store has already stored.
   * @param inStock - In-stock snapshots, already keyed.
   * @param canon - What the catalogue knows, by match key.
   * @param reporter - Optional progress reporter.
   * @param signal - Optional LLM deadline.
   * @returns Resolves once extraction has been attempted.
   */
  private async runNameExtraction(
    known: Set<string>,
    inStock: ProductSnapshot[],
    canon: Map<string, ProductMatchRow>,
    reporter?: ScrapeProgressReporter,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.llmNames.enabled || !inStock.length) {
      return;
    }

    const pending = inStock.filter((snap) =>
      !known.has(snap.storeSku) && this.stored(snap, canon) === undefined
    );

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
   * Classifies the flavor profile of the bottlings the model has never
   * answered for.
   *
   * Reuse across stores is now structural rather than looked up: a listing
   * whose key resolves to a bottling that already carries a `lastLlmFlavorAt`
   * is simply not asked about, and its stored tags are what every store's row
   * reads. That is strictly stronger than the name-string lookup it replaces,
   * which missed the spellings the key folds together (`The Glenlivet` and
   * `Glenlivet`) and so paid twice for one whisky, sometimes getting two
   * different answers.
   *
   * A backfill run waives the "new to this store" half of the gate, which is
   * what lets it fill in bottlings whose classification was never obtained.
   * It is also the one moment the model sees a store's description:
   * `rawAttrs` is never persisted, so the standalone `enrich-flavors` script
   * can only ever ground on the name.
   *
   * @param known - SKUs the store has already stored.
   * @param inStock - In-stock snapshots, already keyed.
   * @param canon - What the catalogue knows, by match key.
   * @param backfill - Whether the wider backfill flavor gate applies.
   * @param reporter - Optional progress reporter.
   * @param signal - Optional LLM deadline.
   * @returns Resolves once classification has been attempted.
   */
  private async runFlavorEnrichment(
    known: Set<string>,
    inStock: ProductSnapshot[],
    canon: Map<string, ProductMatchRow>,
    backfill: boolean,
    reporter?: ScrapeProgressReporter,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.llmFlavor.enabled || !inStock.length) {
      return;
    }

    const pending = inStock.filter((snap) => {
      if (!backfill && known.has(snap.storeSku)) {
        return false;
      }

      return (this.stored(snap, canon)?.lastLlmFlavorAt ?? null) === null;
    });

    if (!pending.length) {
      return;
    }

    const groups = ScrapeService.groupByFlavorKey(pending);

    this.logger.debug(
      'Flavor pass: %d listing(s) cover %d unclassified bottling(s)',
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
   * What the catalogue knows about the bottling a snapshot describes.
   *
   * @param snap - The keyed snapshot.
   * @param canon - The lookup built by {@link loadCanonical}.
   * @returns The stored row, or undefined when the bottling is new or the
   *   snapshot carries no key at all.
   */
  private stored(
    snap: ProductSnapshot,
    canon: Map<string, ProductMatchRow>,
  ): ProductMatchRow | undefined {
    return snap.matchKey ? canon.get(snap.matchKey) : undefined;
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
