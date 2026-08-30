import 'reflect-metadata';

import { NormalizeService } from '../../src/scrape/normalize/normalize.service';
import { ScrapeService } from '../../src/scrape/scrape.service';

import type { CoreBrandService } from '~core/brand';
import type { CoreProductService } from '~core/product';
import type { CoreStoreService } from '~core/store';
import type { CoreStoreConfigService } from '~core/store-config';
import type { CoreStoreProductService } from '~core/store-product';
import { ListingStop } from '~enums';
import type {
  ListingResult,
  ProductMatchRow,
  ProductSnapshot,
  ScrapeAdapter,
  ScrapeAdapterFactory,
  StoreListItem,
} from '~types';
import type { LlmEnrichmentService } from '../../src/scrape/llm/llm-enrichment.service';
import type { LlmFlavorService } from '../../src/scrape/llm/llm-flavor.service';
import type { LlmNameExtractionService } from '../../src/scrape/llm/llm-name-extraction.service';
import type { ScrapePersistService } from '../../src/scrape/persist/scrape-persist.service';

const STORE: StoreListItem = {
  id: 'store-1',
  slug: 'faux',
  name: 'Faux',
  baseUrl: 'https://faux.test',
  color: null,
  active: true,
  tier: 1,
  needsBrowser: false,
  retailChain: null,
  category: null,
  group: null,
  engine: 'ts',
  lastSuccessfulSyncAt: null,
};

/**
 * What a test wants to vary about the collaborators; everything omitted gets
 * an inert default (no stored SKUs, both LLM passes disabled).
 */
interface HarnessOptions {
  existingSkus: Set<string>;
  catalogue: Map<string, ProductMatchRow>;
  brandNames: string[];
  names: { enabled: boolean; extractNames: jest.Mock };
  llm: { enabled: boolean; enrich: jest.Mock };
  flavor: { enabled: boolean; classify: jest.Mock };
  persist: { persist: jest.Mock };
}

/**
 * The service under test plus the mocks a test needs to assert against.
 */
interface Harness extends HarnessOptions {
  service: ScrapeService;
  products: { findByMatchKeys: jest.Mock };
  offers: { existingSkus: jest.Mock };
}

/**
 * A bottling the catalogue already knows. Every field defaults to "filled", so
 * a test states only the gaps it wants a pass to chase.
 *
 * `flavorsCuratedAt` is the exception: "filled" for it would mean *curated*,
 * which locks both flavor passes out of the row, so the default is the
 * uncurated `null`. It has to be stated rather than left off — the repository
 * always selects the column, and `isIncomplete` compares it with `===`, so an
 * absent property is a shape production never produces.
 */
function stored(over: Partial<ProductMatchRow> = {}): ProductMatchRow {
  return {
    id: 'product-1',
    matchKey: 'k',
    name: 'Aberlour',
    abv: 40,
    volumeMl: 700,
    typeId: 'type-1',
    countryId: 'country-1',
    lastLlmFlavorAt: new Date('2026-08-01T00:00:00Z'),
    flavorsCuratedAt: null,
    ...over,
  };
}

/**
 * A `fetchListing` stub for a walk that reached the end of the store's
 * listing. That is the normal case and what every test not specifically about
 * completeness wants, since it is what lets persist sweep.
 *
 * @param items - The snapshots the walk collected.
 * @param over - Completeness fields to override, for the tests that care.
 * @returns The stubbed adapter method.
 */
function listingMock(
  items: ProductSnapshot[],
  over: Partial<ListingResult> = {},
): jest.Mock {
  const listing: ListingResult = {
    items,
    complete: true,
    stop: ListingStop.EXHAUSTED,
    statedItems: null,
    ...over,
  };

  return jest.fn().mockResolvedValue(listing);
}

function rawSnap(over: Partial<ProductSnapshot>): ProductSnapshot {
  return {
    storeSlug: 'faux',
    storeSku: 'x',
    url: 'https://faux.test/x',
    name: 'Віскі Aberlour 12 років 40% 0.7л',
    price: 100,
    brand: null,
    oldPrice: null,
    currency: 'UAH',
    inStock: true,
    promo: false,
    volumeMl: null,
    abv: null,
    ageYears: null,
    whiskyType: null,
    country: null,
    flavorTags: [],
    rawAttrs: {},
    factSources: {},
    ...over,
  };
}

function makeHarness(
  adapter: ScrapeAdapter,
  over: Partial<HarnessOptions> = {},
): Harness {
  const options: HarnessOptions = {
    existingSkus: new Set<string>(),
    catalogue: new Map<string, ProductMatchRow>(),
    brandNames: [],
    names: { enabled: false, extractNames: jest.fn() },
    llm: { enabled: false, enrich: jest.fn() },
    flavor: { enabled: false, classify: jest.fn() },
    persist: { persist: jest.fn() },
    ...over,
  };

  const stores = {
    findWithConfigBySlug: jest.fn().mockResolvedValue(STORE),
  } as unknown as CoreStoreService;

  const storeConfigs = {
    findOne: jest.fn().mockResolvedValue({ delayFrom: 0, delayTo: 0 }),
  } as unknown as CoreStoreConfigService;

  const products = {
    findByMatchKeys: jest.fn().mockImplementation((keys: string[]) =>
      new Map(
        keys
          .filter((key) => options.catalogue.has(key))
          .map((key) => [key, options.catalogue.get(key)]),
      )
    ),
  };

  const offers = {
    existingSkus: jest.fn().mockResolvedValue(options.existingSkus),
  };

  const brands = {
    listNames: jest.fn().mockResolvedValue(options.brandNames),
  } as unknown as CoreBrandService;

  const factory: ScrapeAdapterFactory = { create: () => adapter };

  const service = new ScrapeService(
    stores,
    storeConfigs,
    products as unknown as CoreProductService,
    offers as unknown as CoreStoreProductService,
    brands,
    factory,
    new NormalizeService(),
    options.llm as unknown as LlmEnrichmentService,
    options.names as unknown as LlmNameExtractionService,
    options.flavor as unknown as LlmFlavorService,
    options.persist as unknown as ScrapePersistService,
  );

  return { ...options, products, offers, service };
}

function makeService(
  adapter: ScrapeAdapter,
  over: Partial<HarnessOptions> = {},
): ScrapeService {
  return makeHarness(adapter, over).service;
}

describe('ScrapeService.collectStore', () => {
  it('dry run returns normalized in-stock items without writing', async () => {
    const close = jest.fn().mockResolvedValue(undefined);
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: listingMock([
        rawSnap({ storeSku: 'a', inStock: true }),
        rawSnap({ storeSku: 'b', inStock: false }),
      ]),
      enrichDetail: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      close,
    };
    const persist = { persist: jest.fn() };

    const service = makeService(adapter, { persist });

    const result = await service.collectStore('faux', { dryRun: true });

    expect(result.found).toBe(2);
    expect(result.stored).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items?.[0].storeSku).toBe('a');
    // Normalization ran on the dry-run items.
    expect(result.items?.[0].volumeMl).toBe(700);
    expect(result.items?.[0].abv).toBe(40);
    expect(persist.persist).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it('a real run persists in-stock items and removals', async () => {
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: listingMock([
        rawSnap({ storeSku: 'a', inStock: true }),
        rawSnap({ storeSku: 'gone', inStock: false }),
      ]),
      enrichDetail: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const persist = {
      persist: jest.fn().mockResolvedValue({
        stored: 1,
        added: 1,
        addedProducts: 1,
        removed: 1,
      }),
    };

    const service = makeService(adapter, { persist });

    const result = await service.collectStore('faux');

    expect(persist.persist).toHaveBeenCalledTimes(1);
    const [storeId, inStock, oosSkus] = persist.persist.mock
      .calls[0] as [string, ProductSnapshot[], string[], string];

    expect(storeId).toBe('store-1');
    expect(inStock.map((snap) => snap.storeSku)).toEqual(['a']);
    expect(oosSkus).toEqual(['gone']);
    /**
     * Every snapshot reaches persist already carrying the bottling it
     * resolves to, so the write cannot disagree with the gates.
     */
    expect(inStock[0].matchKey).toBe('aberlour|v700|a12');
    expect(result).toEqual({
      slug: 'faux',
      found: 2,
      stored: 1,
      added: 1,
      addedProducts: 1,
      removed: 1,
      listingComplete: true,
      listingStop: ListingStop.EXHAUSTED,
      statedItems: null,
    });
  });

  /**
   * Persist decides the sweep on this flag, and the orchestrator decides the
   * run's outcome on it, so it has to survive the trip out of the adapter
   * rather than being re-derived from the item count anywhere downstream.
   */
  it('carries an incomplete listing through to the result', async () => {
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: listingMock(
        [rawSnap({ storeSku: 'a', inStock: true })],
        {
          complete: false,
          stop: ListingStop.PAGE_FAILED,
          statedItems: 300,
        },
      ),
      enrichDetail: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const persist = {
      persist: jest.fn().mockResolvedValue({
        stored: 1,
        added: 0,
        addedProducts: 0,
        removed: 0,
      }),
    };
    const service = makeService(adapter, { persist });

    const result = await service.collectStore('faux');

    expect(result.listingComplete).toBe(false);
    expect(result.listingStop).toBe(ListingStop.PAGE_FAILED);
    expect(result.statedItems).toBe(300);

    const [, , , , listing] = persist.persist.mock.calls[0] as [
      string,
      ProductSnapshot[],
      string[],
      string,
      ListingResult,
    ];

    expect(listing.complete).toBe(false);
  });

  it(
    'enriches only the SKUs the store has never stored, and paces them',
    async () => {
      const sleep = jest.fn().mockResolvedValue(undefined);
      const enrichDetail = jest.fn().mockResolvedValue(true);
      const adapter: ScrapeAdapter = {
        slug: 'faux',
        supportsDetail: true,
        fetchListing: listingMock([
          rawSnap({ storeSku: 'known' }),
          rawSnap({ storeSku: 'fresh' }),
        ]),
        enrichDetail,
        sleep,
        close: jest.fn().mockResolvedValue(undefined),
      };

      /**
       * A stored row's detail fields are never written on conflict, so
       * re-fetching its page could not be persisted.
       */
      const service = makeService(adapter, {
        existingSkus: new Set(['known']),
      });

      await service.collectStore('faux', { dryRun: true });

      expect(enrichDetail).toHaveBeenCalledTimes(1);
      expect(enrichDetail).toHaveBeenCalledWith(
        expect.objectContaining({ storeSku: 'fresh' }),
      );
      expect(sleep).toHaveBeenCalledTimes(1);
    },
  );

  it('does not fetch details for out-of-stock items', async () => {
    const enrichDetail = jest.fn().mockResolvedValue(true);
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: true,
      fetchListing: listingMock([
        rawSnap({ storeSku: 'listed', inStock: true }),
        rawSnap({ storeSku: 'ghost', inStock: false }),
      ]),
      enrichDetail,
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };

    await makeService(adapter).collectStore('faux', { dryRun: true });

    /**
     * An out-of-stock item is never upserted, so its detail data has nowhere
     * to go — fetching its page would be pure politeness-delay spend.
     */
    expect(enrichDetail).toHaveBeenCalledTimes(1);
    expect(enrichDetail).toHaveBeenCalledWith(
      expect.objectContaining({ storeSku: 'listed' }),
    );
  });

  it('stops detail enrichment once the soft deadline fired', async () => {
    const enrichDetail = jest.fn().mockResolvedValue(true);
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: true,
      fetchListing: listingMock([
        rawSnap({ storeSku: 'a' }),
        rawSnap({ storeSku: 'b' }),
      ]),
      enrichDetail,
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const events: { done: number; pending: number }[] = [];
    const controller = new AbortController();

    controller.abort();

    const result = await makeService(adapter).collectStore('faux', {
      dryRun: true,
      deadline: controller.signal,
      reporter: (event) => {
        if (event.kind === 'detail-deadline') {
          events.push({ done: event.done, pending: event.pending });
        }
      },
    });

    expect(enrichDetail).not.toHaveBeenCalled();
    expect(events).toEqual([{ done: 0, pending: 2 }]);

    /**
     * The run still succeeds: the listing is what a sync is for, and the
     * skipped pages only held secondary fields.
     */
    expect(result.found).toBe(2);
  });

  it('a failing detail page does not abort the enrichment pass', async () => {
    const enrichDetail = jest.fn()
      .mockRejectedValueOnce(new Error('502'))
      .mockResolvedValue(true);
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: true,
      fetchListing: listingMock([
        rawSnap({ storeSku: 'a' }),
        rawSnap({ storeSku: 'b' }),
      ]),
      enrichDetail,
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };

    const result = await makeService(adapter)
      .collectStore('faux', { dryRun: true });

    expect(enrichDetail).toHaveBeenCalledTimes(2);
    expect(result.found).toBe(2);
  });

  it('asks the LLM about fields only for new SKUs', async () => {
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: listingMock([
        // No specs in either name, so both items lack ABV and volume.
        rawSnap({ storeSku: 'known', name: 'Віскі Aberlour' }),
        rawSnap({ storeSku: 'fresh', name: 'Віскі Ardbeg Ten' }),
      ]),
      enrichDetail: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const llm = { enabled: true, enrich: jest.fn() };

    const service = makeService(adapter, {
      llm,
      existingSkus: new Set(['known']),
    });

    await service.collectStore('faux', { dryRun: true });

    expect(llm.enrich).toHaveBeenCalledTimes(1);

    /**
     * The stored SKU's answer could never be persisted — the upsert writes
     * these columns on insert alone — so paying for it would be waste.
     */
    const [pending] = llm.enrich.mock.calls[0] as [ProductSnapshot[]];

    expect(pending.map((snap) => snap.storeSku)).toEqual(['fresh']);
  });

  it('extracts names only for SKUs the store has never stored', async () => {
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: listingMock([
        rawSnap({ storeSku: 'known' }),
        rawSnap({ storeSku: 'fresh' }),
      ]),
      enrichDetail: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const names = { enabled: true, extractNames: jest.fn() };

    const service = makeService(adapter, {
      names,
      existingSkus: new Set(['known']),
    });

    await service.collectStore('faux', { dryRun: true });

    expect(names.extractNames).toHaveBeenCalledTimes(1);

    const [pending] = names.extractNames.mock.calls[0] as [ProductSnapshot[]];

    expect(pending.map((snap) => snap.storeSku)).toEqual(['fresh']);
  });

  it(
    'classifies flavors only for SKUs the store has never stored',
    async () => {
      const adapter: ScrapeAdapter = {
        slug: 'faux',
        supportsDetail: false,
        fetchListing: listingMock([
          rawSnap({ storeSku: 'known' }),
          rawSnap({ storeSku: 'fresh' }),
        ]),
        enrichDetail: jest.fn(),
        sleep: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
      };
      const flavor = { enabled: true, classify: jest.fn() };

      const harness = makeHarness(adapter, {
        flavor,
        existingSkus: new Set(['known']),
      });

      await harness.service.collectStore('faux', { dryRun: true });

      expect(flavor.classify).toHaveBeenCalledTimes(1);

      const [pending] = flavor.classify.mock.calls[0] as [ProductSnapshot[]];

      expect(pending.map((snap) => snap.storeSku)).toEqual(['fresh']);

      /**
       * Both passes gate on the same lookup, so it must be fetched once.
       */
      expect(harness.offers.existingSkus).toHaveBeenCalledTimes(1);
    },
  );

  it(
    'reuses a stored answer instead of re-classifying the same bottling',
    async () => {
      const adapter: ScrapeAdapter = {
        slug: 'faux',
        supportsDetail: false,
        fetchListing: listingMock([
          rawSnap({ storeSku: 'a', name: 'Віскі Aberlour 12 років 40% 0.7л' }),
          rawSnap({ storeSku: 'b', name: 'Віскі Ardbeg Ten 46% 0.7л' }),
        ]),
        enrichDetail: jest.fn(),
        sleep: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
      };
      const flavor = { enabled: true, classify: jest.fn() };

      const harness = makeHarness(adapter, {
        flavor,
        catalogue: new Map([['aberlour|v700|a12', stored()]]),
      });

      await harness.service.collectStore('faux', { dryRun: true });

      /**
       * The lookup key carries the expression: `Ten` is part of the product,
       * not a spec token, so the two listings are two different bottlings.
       */
      expect(harness.products.findByMatchKeys).toHaveBeenCalledWith(
        expect.arrayContaining(['aberlour|v700|a12', 'ardbegten|v700|a0']),
      );

      /**
       * Only the bottling with no answer on file reaches the model — the other
       * one's tags are already stored against the row every store reads.
       */
      expect(flavor.classify).toHaveBeenCalledTimes(1);

      const [pending] = flavor.classify.mock.calls[0] as [ProductSnapshot[]];

      expect(pending.map((snap) => snap.storeSku)).toEqual(['b']);
    },
  );

  it('asks about a bottling once however many SKUs list it', async () => {
    /**
     * A store listing the same bottle plain and boxed has two SKUs and one
     * flavor profile. A different size is a different bottling, though — the
     * volume is part of the identity — so it is asked about separately.
     */
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: listingMock([
        rawSnap({ storeSku: 'a', name: 'Віскі Aberlour 12 років 40% 0.7л' }),
        rawSnap({
          storeSku: 'b',
          name: 'Віскі Aberlour 12 років 40% 0.7л в коробці',
        }),
        rawSnap({ storeSku: 'c', name: 'Віскі Ardbeg Ten 46% 0.7л' }),
      ]),
      enrichDetail: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const flavor = {
      enabled: true,
      classify: jest.fn().mockImplementation((heads: ProductSnapshot[]) => {
        heads.forEach((head) => {
          head.llmFlavorTags = ['sherry'];
          head.llmFlavorConfidence = 'high';
          head.llmFlavorChecked = true;
        });

        return Promise.resolve();
      }),
    };

    const service = makeService(adapter, { flavor });

    const result = await service.collectStore('faux', { dryRun: true });

    const [heads] = flavor.classify.mock.calls[0] as [ProductSnapshot[]];

    expect(heads.map((snap) => snap.storeSku)).toEqual(['a', 'c']);

    /**
     * The sibling carries the head's answer, so the two rows cannot end up
     * tagged differently.
     */
    const sibling = result.items?.find((snap) => snap.storeSku === 'b');

    expect(sibling?.llmFlavorTags).toEqual(['sherry']);
    expect(sibling?.llmFlavorConfidence).toBe('high');
    expect(sibling?.llmFlavorChecked).toBe(true);
  });

  it('leaves a group unchecked when its head went unanswered', async () => {
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: listingMock([
        rawSnap({ storeSku: 'a', name: 'Віскі Aberlour 12 років 40% 0.7л' }),
        rawSnap({
          storeSku: 'b',
          name: 'Віскі Aberlour 12 років 40% 0.7л в коробці',
        }),
      ]),
      enrichDetail: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const flavor = { enabled: true, classify: jest.fn() };

    const service = makeService(adapter, { flavor });

    const result = await service.collectStore('faux', { dryRun: true });

    /**
     * Half a group recorded as checked would never be asked about again.
     */
    expect(result.items?.every((snap) => snap.llmFlavorChecked === undefined))
      .toBe(true);
  });

  it('skips every LLM pass once the run is out of LLM budget', async () => {
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: listingMock([rawSnap({})]),
      enrichDetail: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const llm = { enabled: true, enrich: jest.fn() };
    const names = { enabled: true, extractNames: jest.fn() };
    const flavor = { enabled: true, classify: jest.fn() };
    const skipped: string[] = [];
    const controller = new AbortController();

    controller.abort();

    const service = makeService(adapter, { llm, names, flavor });

    const result = await service.collectStore('faux', {
      dryRun: true,
      deadline: controller.signal,
      reporter: (event) => {
        if (event.kind === 'llm-deadline') {
          skipped.push(event.pass);
        }
      },
    });

    expect(llm.enrich).not.toHaveBeenCalled();
    expect(names.extractNames).not.toHaveBeenCalled();
    expect(flavor.classify).not.toHaveBeenCalled();

    /**
     * The collection still succeeds: the scraped listing is what a sync is
     * for, and the model's answers are asked for again next run.
     */
    expect(result.items).toHaveLength(1);

    /**
     * The fields pass reports nothing because it had nothing to ask about —
     * this name states its own ABV and volume, so no field was missing.
     */
    expect(skipped).toEqual(['names', 'flavors']);
  });

  it('does not call the model when every answer is stored', async () => {
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: listingMock([rawSnap({ storeSku: 'a' })]),
      enrichDetail: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const flavor = { enabled: true, classify: jest.fn() };

    const service = makeService(adapter, {
      flavor,
      catalogue: new Map([['aberlour|v700|a12', stored()]]),
    });

    await service.collectStore('faux', { dryRun: true });

    expect(flavor.classify).not.toHaveBeenCalled();
  });

  it('skips the flavor pass when the LLM is disabled', async () => {
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: listingMock([rawSnap({})]),
      enrichDetail: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const flavor = { enabled: false, classify: jest.fn() };

    const service = makeService(adapter, { flavor });

    await service.collectStore('faux', { dryRun: true });

    expect(flavor.classify).not.toHaveBeenCalled();
  });

  it('skips the name-extraction pass when the LLM is disabled', async () => {
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: listingMock([rawSnap({ storeSku: 'a' })]),
      enrichDetail: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const names = { enabled: false, extractNames: jest.fn() };

    const service = makeService(adapter, { names });

    await service.collectStore('faux', { dryRun: true });

    expect(names.extractNames).not.toHaveBeenCalled();
  });

  it('reads a missing brand off the name via the brand index', async () => {
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: listingMock([rawSnap({ storeSku: 'a' })]),
      enrichDetail: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };

    const service = makeService(adapter, {
      brandNames: ['Aberlour', 'Highland Park'],
    });

    const result = await service.collectStore('faux', { dryRun: true });

    expect(result.items?.[0].brand).toBe('Aberlour');
  });
});

describe('ScrapeService.collectStore in backfill mode', () => {
  it('gates detail fetches on the wider set of stored fields', async () => {
    const enrichDetail = jest.fn().mockResolvedValue(true);
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: true,
      fetchListing: listingMock([
        rawSnap({
          storeSku: 'complete',
          name: 'Віскі Aberlour 12 років 40% 0.7л',
        }),
        rawSnap({ storeSku: 'partial', name: 'Віскі Ardbeg Ten 46% 0.7л' }),
      ]),
      enrichDetail,
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };

    /**
     * Both SKUs are stored, which a normal run would skip outright. The
     * backfill gate looks past that — but only at the bottling the catalogue
     * is still missing something for.
     */
    const harness = makeHarness(adapter, {
      existingSkus: new Set(['complete', 'partial']),
      catalogue: new Map([
        ['aberlour|v700|a12', stored()],
        ['ardbegten|v700|a0', stored({ countryId: null })],
      ]),
    });

    await harness.service.collectStore('faux', {
      dryRun: true,
      backfill: true,
    });

    expect(enrichDetail).toHaveBeenCalledTimes(1);
    expect(enrichDetail).toHaveBeenCalledWith(
      expect.objectContaining({ storeSku: 'partial' }),
    );
  });

  it('skips a detail fetch another store already paid for', async () => {
    const enrichDetail = jest.fn().mockResolvedValue(true);
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: true,
      fetchListing: listingMock([rawSnap({ storeSku: 'new' })]),
      enrichDetail,
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };

    /**
     * The SKU is new to this store, which used to be enough to buy its detail
     * page. The bottling is not new to the catalogue, so there is nothing left
     * to learn — this is the saving the shared catalogue buys.
     */
    const harness = makeHarness(adapter, {
      catalogue: new Map([['aberlour|v700|a12', stored()]]),
    });

    await harness.service.collectStore('faux', { dryRun: true });

    expect(enrichDetail).not.toHaveBeenCalled();
  });

  it('asks the LLM about stored SKUs too', async () => {
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: listingMock([
        // No specs in the name, so ABV and volume stay missing.
        rawSnap({ storeSku: 'known', name: 'Віскі Aberlour' }),
      ]),
      enrichDetail: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const llm = { enabled: true, enrich: jest.fn() };

    const service = makeService(adapter, {
      llm,
      existingSkus: new Set(['known']),
    });

    await service.collectStore('faux', { dryRun: true, backfill: true });

    /**
     * The backfill upsert fills still-null columns on conflict, so here a
     * stored row's answer is persistable and worth paying for.
     */
    expect(llm.enrich).toHaveBeenCalledTimes(1);

    const [pending] = llm.enrich.mock.calls[0] as [ProductSnapshot[]];

    expect(pending.map((snap) => snap.storeSku)).toEqual(['known']);
  });

  it('asks the LLM about a missing type or country as well', async () => {
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: listingMock([
        // ABV and volume are in the name, so only type/country stay missing.
        rawSnap({ storeSku: 'a', name: 'Nomad Outland 40% 0.7л' }),
      ]),
      enrichDetail: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const llm = { enabled: true, enrich: jest.fn() };

    const plain = makeService(adapter, { llm });

    await plain.collectStore('faux', { dryRun: true });

    expect(llm.enrich).not.toHaveBeenCalled();

    const backfilling = makeService(adapter, { llm });

    await backfilling.collectStore('faux', {
      dryRun: true,
      backfill: true,
    });

    expect(llm.enrich).toHaveBeenCalledTimes(1);
  });

  it('classifies stored rows with no flavor answer on file', async () => {
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: listingMock([
        rawSnap({ storeSku: 'unanswered', name: 'Віскі Aberlour' }),
        rawSnap({ storeSku: 'answered', name: 'Віскі Bowmore' }),
      ]),
      enrichDetail: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const flavor = { enabled: true, classify: jest.fn() };

    const service = makeService(adapter, {
      flavor,
      existingSkus: new Set(['unanswered', 'answered']),
      catalogue: new Map([['bowmore|v0|a0', stored()]]),
    });

    await service.collectStore('faux', { dryRun: true, backfill: true });

    /**
     * `setLlmFlavors` is a plain update rather than an insert-only write, so a
     * stored bottling's answer is persistable — but only asked for once, since
     * `lastLlmFlavorAt` is stamped even for an "unknown" answer.
     */
    expect(flavor.classify).toHaveBeenCalledTimes(1);

    const [pending] = flavor.classify.mock.calls[0] as [ProductSnapshot[]];

    expect(pending.map((snap) => snap.storeSku)).toEqual(['unanswered']);
  });

  it('leaves a normal run still skipping stored rows', async () => {
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: listingMock([
        rawSnap({ storeSku: 'unanswered', name: 'Віскі Aberlour' }),
      ]),
      enrichDetail: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const flavor = { enabled: true, classify: jest.fn() };

    const harness = makeHarness(adapter, {
      flavor,
      existingSkus: new Set(['unanswered']),
    });

    await harness.service.collectStore('faux', { dryRun: true });

    expect(flavor.classify).not.toHaveBeenCalled();
  });
});
