import 'reflect-metadata';

import { NormalizeService } from '../../src/scrape/normalize/normalize.service';
import { ScrapeService } from '../../src/scrape/scrape.service';

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

function makeService(
  adapter: ScrapeAdapter,
  persist: { persist: jest.Mock },
  skusWithAbv: Set<string> = new Set<string>(),
  names: { enabled: boolean; extractNames: jest.Mock } = {
    enabled: false,
    extractNames: jest.fn(),
  },
  existingSkus: Set<string> = new Set<string>(),
): ScrapeService {
  const stores = {
    findWithConfigBySlug: jest.fn().mockResolvedValue(STORE),
  } as unknown as CoreStoreService;

  const storeConfigs = {
    findOne: jest.fn().mockResolvedValue({ delayFrom: 0, delayTo: 0 }),
  } as unknown as CoreStoreConfigService;

  const products = {
    skusWithAbv: jest.fn().mockResolvedValue(skusWithAbv),
    existingSkus: jest.fn().mockResolvedValue(existingSkus),
  } as unknown as CoreProductService;

  const factory: ScrapeAdapterFactory = { create: () => adapter };

  const llm = {
    enabled: false,
    enrich: jest.fn(),
  } as unknown as LlmEnrichmentService;

  return new ScrapeService(
    stores,
    storeConfigs,
    products,
    factory,
    new NormalizeService(),
    llm,
    names as unknown as LlmNameExtractionService,
    persist as unknown as ScrapePersistService,
  );
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

    const service = makeService(adapter, persist);

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

    const service = makeService(adapter, persist);

    const result = await service.collectStore('faux');

    expect(persist.persist).toHaveBeenCalledTimes(1);
    const [storeId, inStock, oosSkus] = persist.persist.mock.calls[0] as [
      string,
      ProductSnapshot[],
      string[],
    ];

    expect(storeId).toBe('store-1');
    expect(inStock.map((snap) => snap.storeSku)).toEqual(['a']);
    expect(oosSkus).toEqual(['gone']);
    expect(result).toEqual({
      slug: 'faux',
      found: 2,
      stored: 1,
      added: 1,
      removed: 1,
    });
  });

  it(
    'enriches only the items whose ABV is not stored, and paces them',
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

      const service = makeService(
        adapter,
        { persist: jest.fn() },
        new Set(['known']),
      );

      await service.collectStore('faux', { dryRun: true });

      expect(enrichDetail).toHaveBeenCalledTimes(1);
      expect(enrichDetail).toHaveBeenCalledWith(
        expect.objectContaining({ storeSku: 'fresh' }),
      );
      expect(sleep).toHaveBeenCalledTimes(1);
    },
  );

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

    const result = await makeService(adapter, { persist: jest.fn() })
      .collectStore('faux', { dryRun: true });

    expect(enrichDetail).toHaveBeenCalledTimes(2);
    expect(result.found).toBe(2);
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

    const service = makeService(
      adapter,
      { persist: jest.fn() },
      new Set<string>(),
      names,
      new Set(['known']),
    );

    await service.collectStore('faux', { dryRun: true });

    expect(names.extractNames).toHaveBeenCalledTimes(1);

    const [pending] = names.extractNames.mock.calls[0] as [ProductSnapshot[]];

    expect(pending.map((snap) => snap.storeSku)).toEqual(['fresh']);
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

    const service = makeService(
      adapter,
      { persist: jest.fn() },
      new Set<string>(),
      names,
    );

    await service.collectStore('faux', { dryRun: true });

    expect(names.extractNames).not.toHaveBeenCalled();
  });
});
