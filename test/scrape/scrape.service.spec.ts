import 'reflect-metadata';

import { NormalizeService } from '../../src/scrape/normalize/normalize.service';
import { ScrapeService } from '../../src/scrape/scrape.service';

import type { CoreBrandService } from '~core/brand';
import type { CoreProductService } from '~core/product';
import type { CoreStoreService } from '~core/store';
import type { CoreStoreConfigService } from '~core/store-config';
import type {
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
  skusWithCoreDetails: Set<string>;
  existingSkus: Set<string>;
  storedLlmFlavors: Map<string, string[]>;
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
  products: {
    skusWithCoreDetails: jest.Mock;
    existingSkus: jest.Mock;
    findLlmFlavorsByNames: jest.Mock;
  };
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
    ...over,
  };
}

function makeHarness(
  adapter: ScrapeAdapter,
  over: Partial<HarnessOptions> = {},
): Harness {
  const options: HarnessOptions = {
    skusWithCoreDetails: new Set<string>(),
    existingSkus: new Set<string>(),
    storedLlmFlavors: new Map<string, string[]>(),
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
    skusWithCoreDetails: jest.fn()
      .mockResolvedValue(options.skusWithCoreDetails),
    existingSkus: jest.fn().mockResolvedValue(options.existingSkus),
    findLlmFlavorsByNames: jest.fn()
      .mockResolvedValue(options.storedLlmFlavors),
  };

  const brands = {
    listNames: jest.fn().mockResolvedValue(options.brandNames),
  } as unknown as CoreBrandService;

  const factory: ScrapeAdapterFactory = { create: () => adapter };

  const service = new ScrapeService(
    stores,
    storeConfigs,
    products as unknown as CoreProductService,
    brands,
    factory,
    new NormalizeService(),
    options.llm as unknown as LlmEnrichmentService,
    options.names as unknown as LlmNameExtractionService,
    options.flavor as unknown as LlmFlavorService,
    options.persist as unknown as ScrapePersistService,
  );

  return { ...options, products, service };
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
      fetchListing: jest.fn().mockResolvedValue([
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
      fetchListing: jest.fn().mockResolvedValue([
        rawSnap({ storeSku: 'a', inStock: true }),
        rawSnap({ storeSku: 'gone', inStock: false }),
      ]),
      enrichDetail: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const persist = {
      persist: jest.fn().mockResolvedValue({ stored: 1, added: 1, removed: 1 }),
    };

    const service = makeService(adapter, { persist });

    const result = await service.collectStore('faux');

    expect(persist.persist).toHaveBeenCalledTimes(1);
    const [storeId, inStock, oosSkus, , backfill] = persist.persist.mock
      .calls[0] as [string, ProductSnapshot[], string[], string, boolean];

    expect(storeId).toBe('store-1');
    expect(inStock.map((snap) => snap.storeSku)).toEqual(['a']);
    expect(oosSkus).toEqual(['gone']);
    expect(backfill).toBe(false);
    expect(result).toEqual({
      slug: 'faux',
      found: 2,
      stored: 1,
      added: 1,
      removed: 1,
    });
  });

  it(
    'enriches only the SKUs the store has never stored, and paces them',
    async () => {
      const sleep = jest.fn().mockResolvedValue(undefined);
      const enrichDetail = jest.fn().mockResolvedValue(true);
      const adapter: ScrapeAdapter = {
        slug: 'faux',
        supportsDetail: true,
        fetchListing: jest.fn().mockResolvedValue([
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
      fetchListing: jest.fn().mockResolvedValue([
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
      fetchListing: jest.fn().mockResolvedValue([
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
      fetchListing: jest.fn().mockResolvedValue([
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
      fetchListing: jest.fn().mockResolvedValue([
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
      fetchListing: jest.fn().mockResolvedValue([
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
        fetchListing: jest.fn().mockResolvedValue([
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
      expect(harness.products.existingSkus).toHaveBeenCalledTimes(1);
    },
  );

  it(
    'reuses a stored answer instead of re-classifying the same bottling',
    async () => {
      const adapter: ScrapeAdapter = {
        slug: 'faux',
        supportsDetail: false,
        fetchListing: jest.fn().mockResolvedValue([
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
        storedLlmFlavors: new Map([['Aberlour', ['sherry', 'honey']]]),
      });

      const result = await harness.service.collectStore('faux', {
        dryRun: true,
      });

      /**
       * The lookup key is the name persist would store, so it carries the
       * expression: `Ten` is part of the product, not a spec token.
       */
      expect(harness.products.findLlmFlavorsByNames).toHaveBeenCalledWith(
        expect.arrayContaining(['Aberlour', 'Ardbeg Ten']),
      );

      const reused = result.items?.find((snap) => snap.storeSku === 'a');

      expect(reused?.llmFlavorTags).toEqual(['honey', 'sherry']);
      expect(reused?.llmFlavorChecked).toBe(true);
      expect(reused?.llmFlavorConfidence).toBeUndefined();

      /**
       * Only the bottling with no stored answer reaches the model.
       */
      expect(flavor.classify).toHaveBeenCalledTimes(1);

      const [pending] = flavor.classify.mock.calls[0] as [ProductSnapshot[]];

      expect(pending.map((snap) => snap.storeSku)).toEqual(['b']);
    },
  );

  it('asks about a bottling once however many SKUs list it', async () => {
    // Two volumes of one whisky are two SKUs but one flavor profile.
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: jest.fn().mockResolvedValue([
        rawSnap({ storeSku: 'a', name: 'Віскі Aberlour 12 років 40% 0.7л' }),
        rawSnap({ storeSku: 'b', name: 'Віскі Aberlour 12 років 40% 1л' }),
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
      fetchListing: jest.fn().mockResolvedValue([
        rawSnap({ storeSku: 'a', name: 'Віскі Aberlour 12 років 40% 0.7л' }),
        rawSnap({ storeSku: 'b', name: 'Віскі Aberlour 12 років 40% 1л' }),
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
      fetchListing: jest.fn().mockResolvedValue([rawSnap({})]),
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
      fetchListing: jest.fn().mockResolvedValue([rawSnap({ storeSku: 'a' })]),
      enrichDetail: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const flavor = { enabled: true, classify: jest.fn() };

    const service = makeService(adapter, {
      flavor,
      storedLlmFlavors: new Map([['Aberlour', ['sherry']]]),
    });

    await service.collectStore('faux', { dryRun: true });

    expect(flavor.classify).not.toHaveBeenCalled();
  });

  it('skips the flavor pass when the LLM is disabled', async () => {
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: jest.fn().mockResolvedValue([rawSnap({})]),
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
      fetchListing: jest.fn().mockResolvedValue([rawSnap({ storeSku: 'a' })]),
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
      fetchListing: jest.fn().mockResolvedValue([rawSnap({ storeSku: 'a' })]),
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
      fetchListing: jest.fn().mockResolvedValue([
        rawSnap({ storeSku: 'complete' }),
        rawSnap({ storeSku: 'partial' }),
      ]),
      enrichDetail,
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };

    /**
     * Both SKUs are stored, which a normal run would skip outright; the
     * backfill gate instead fetches whichever stored row is incomplete.
     */
    const harness = makeHarness(adapter, {
      existingSkus: new Set(['complete', 'partial']),
      skusWithCoreDetails: new Set(['complete']),
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

  it('tells the persist step to fill still-null columns', async () => {
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: jest.fn().mockResolvedValue([rawSnap({ storeSku: 'a' })]),
      enrichDetail: jest.fn(),
      sleep: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const persist = {
      persist: jest.fn().mockResolvedValue({ stored: 1, added: 0, removed: 0 }),
    };

    await makeService(adapter, { persist })
      .collectStore('faux', { backfill: true });

    expect(persist.persist).toHaveBeenCalledWith(
      'store-1',
      expect.anything(),
      [],
      expect.any(String),
      true,
      undefined,
    );
  });

  it('asks the LLM about stored SKUs too', async () => {
    const adapter: ScrapeAdapter = {
      slug: 'faux',
      supportsDetail: false,
      fetchListing: jest.fn().mockResolvedValue([
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
      fetchListing: jest.fn().mockResolvedValue([
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
});
