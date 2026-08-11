import 'reflect-metadata';

import { ScrapePersistService } from '../../src/scrape/persist/scrape-persist.service';

import type { CoreBrandService } from '~core/brand';
import type { CoreCountryService } from '~core/country';
import type { CoreFlavorService } from '~core/flavor';
import type { CorePriceSnapshotService } from '~core/price-snapshot';
import type { CoreProductService } from '~core/product';
import type { CoreStoreProductService } from '~core/store-product';
import type { CoreTypeService } from '~core/type';
import type { ProductSnapshot } from '~types';

/**
 * The persist path is exercised without a database: the transaction wrapper is
 * stubbed out and every core service is a mock. What is under test here is the
 * decision-making — which bottling a snapshot resolves to, what may be written
 * to it, and the out-of-stock flagging — while the SQL itself is covered by the
 * persistence integration spec.
 */
jest.mock('typeorm-transactional', () => ({
  Transactional: () => (): void => undefined,
}));

const STORE_ID = 'store-1';
const DAY = '2026-08-08';

function snap(
  sku: string,
  over: Partial<ProductSnapshot> = {},
): ProductSnapshot {
  return {
    storeSlug: 'faux',
    storeSku: sku,
    url: `https://faux.test/${sku}`,
    name: 'Sample',
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

interface ProductMocks {
  findOrCreateByMatchKeys: jest.Mock;
  createUnmatched: jest.Mock;
  fillMissing: jest.Mock;
  addScrapeFlavors: jest.Mock;
  setLlmFlavors: jest.Mock;
}

interface OfferMocks {
  countByStore: jest.Mock;
  existingSkus: jest.Mock;
  upsertFromScrape: jest.Mock;
  markOutOfStockExcept: jest.Mock;
  markOutOfStockBySkus: jest.Mock;
}

interface Harness {
  service: ScrapePersistService;
  products: ProductMocks;
  offers: OfferMocks;
  snapshots: { upsertForDate: jest.Mock };
}

function makeService(
  inStockBefore: number,
  names: Map<string, string> = new Map<string, string>(),
  known: string[] = [],
): Harness {
  const lookups = {
    resolveByName: jest.fn().mockResolvedValue(names),
    resolveByNameUa: jest.fn().mockResolvedValue(new Map<string, string>()),
  };

  const products = {
    findOrCreateByMatchKeys: jest.fn().mockImplementation((inputs: {
      matchKey: string;
    }[]) => ({
      ids: new Map(inputs.map((input) => [input.matchKey, 'product-1'])),
      added: inputs.length,
    })),
    createUnmatched: jest.fn().mockResolvedValue('product-unmatched'),
    fillMissing: jest.fn().mockResolvedValue(0),
    addScrapeFlavors: jest.fn().mockResolvedValue(undefined),
    setLlmFlavors: jest.fn().mockResolvedValue(undefined),
  };

  const offers = {
    countByStore: jest.fn().mockResolvedValue(inStockBefore),
    existingSkus: jest.fn().mockResolvedValue(new Set(known)),
    upsertFromScrape: jest.fn().mockImplementation((
      input: { sku: string; productId: string | null },
    ) => ({
      id: `offer-${input.sku}`,
      productId: input.productId ?? 'product-stored',
      isNew: input.productId !== null,
    })),
    markOutOfStockExcept: jest.fn().mockResolvedValue(3),
    markOutOfStockBySkus: jest.fn().mockResolvedValue(1),
  };

  const snapshots = {
    upsertForDate: jest.fn().mockResolvedValue(undefined),
  };

  const service = new ScrapePersistService(
    lookups as unknown as CoreBrandService,
    lookups as unknown as CoreTypeService,
    lookups as unknown as CoreFlavorService,
    lookups as unknown as CoreCountryService,
    products as unknown as CoreProductService,
    offers as unknown as CoreStoreProductService,
    snapshots as unknown as CorePriceSnapshotService,
  );

  return { service, products, offers, snapshots };
}

describe('ScrapePersistService — the out-of-stock sweep', () => {
  it('sweeps everything not seen in stock on a healthy run', async () => {
    const { service, offers } = makeService(4);

    const counts = await service.persist(
      STORE_ID,
      [snap('a'), snap('b')],
      ['gone'],
      DAY,
    );

    expect(offers.markOutOfStockExcept).toHaveBeenCalledWith(
      STORE_ID,
      ['a', 'b'],
    );
    expect(offers.markOutOfStockBySkus).not.toHaveBeenCalled();
    expect(counts.removed).toBe(3);
  });

  it('skips the sweep when the listing looks truncated', async () => {
    const { service, offers } = makeService(10);

    const counts = await service.persist(
      STORE_ID,
      [snap('a'), snap('b')],
      ['gone'],
      DAY,
    );

    expect(offers.markOutOfStockExcept).not.toHaveBeenCalled();
    expect(offers.markOutOfStockBySkus).toHaveBeenCalledWith(
      STORE_ID,
      ['gone'],
    );
    expect(counts.removed).toBe(1);
  });

  it('reports a skipped sweep, which the run log has to show', async () => {
    const { service } = makeService(10);
    const reporter = jest.fn();

    await service.persist(
      STORE_ID,
      [snap('a'), snap('b')],
      ['gone'],
      DAY,
      reporter,
    );

    expect(reporter).toHaveBeenCalledWith({
      kind: 'sweep-guarded',
      inStock: 2,
      baseline: 10,
    });
  });

  it('sweeps an empty store without tripping the guard', async () => {
    const { service, offers } = makeService(0);

    await service.persist(STORE_ID, [], [], DAY);

    expect(offers.markOutOfStockExcept).toHaveBeenCalledWith(STORE_ID, []);
    expect(offers.markOutOfStockBySkus).not.toHaveBeenCalled();
  });
});

describe('ScrapePersistService — resolving a bottling', () => {
  it('creates a bottling for a SKU the store has never listed', async () => {
    const { service, products, offers } = makeService(1);
    const item = snap('a');

    item.name = 'Віскі Aberlour 12 років 40% 0,7л';
    item.cleanName = 'Aberlour';
    item.ageYears = 12;
    item.volumeMl = 700;

    await service.persist(STORE_ID, [item], [], DAY);

    expect(products.findOrCreateByMatchKeys).toHaveBeenCalledWith([
      expect.objectContaining({
        matchKey: 'aberlour|v700|a12',
        name: 'Aberlour',
        age: 12,
        volumeMl: 700,
      }),
    ]);
    expect(offers.upsertFromScrape).toHaveBeenCalledWith(
      expect.objectContaining({
        sku: 'a',
        productId: 'product-1',
        nameOrig: 'Віскі Aberlour 12 років 40% 0,7л',
      }),
    );
  });

  it('leaves a stored SKU pointing where it already links', async () => {
    const { service, products, offers } = makeService(1, new Map(), ['a']);

    await service.persist(STORE_ID, [snap('a')], [], DAY);

    expect(products.findOrCreateByMatchKeys).toHaveBeenCalledWith([]);
    expect(offers.upsertFromScrape).toHaveBeenCalledWith(
      expect.objectContaining({ sku: 'a', productId: null }),
    );
  });

  it('prefers the key the collection passes already settled on', async () => {
    const { service, products } = makeService(1);

    await service.persist(
      STORE_ID,
      [snap('a', { matchKey: 'settled|v700|a0' })],
      [],
      DAY,
    );

    expect(products.findOrCreateByMatchKeys).toHaveBeenCalledWith([
      expect.objectContaining({ matchKey: 'settled|v700|a0' }),
    ]);
  });

  it('sends one sorted entry per key, so stores agree', async () => {
    const { service, products } = makeService(1);

    await service.persist(
      STORE_ID,
      [
        snap('a', { matchKey: 'zulu|v700|a0' }),
        snap('b', { matchKey: 'alpha|v700|a0' }),
        snap('c', { matchKey: 'zulu|v700|a0' }),
      ],
      [],
      DAY,
    );

    expect(products.findOrCreateByMatchKeys).toHaveBeenCalledWith([
      expect.objectContaining({ matchKey: 'alpha|v700|a0' }),
      expect.objectContaining({ matchKey: 'zulu|v700|a0' }),
    ]);
  });

  it('gives an unmatchable listing a bottling of its own', async () => {
    const { service, products, offers } = makeService(1);

    await service.persist(
      STORE_ID,
      [snap('a', { matchKey: null, name: 'Віскі' })],
      [],
      DAY,
    );

    expect(products.createUnmatched).toHaveBeenCalledTimes(1);
    expect(offers.upsertFromScrape).toHaveBeenCalledWith(
      expect.objectContaining({ productId: 'product-unmatched' }),
    );
  });

  it('counts new bottlings apart from new offers', async () => {
    const { service } = makeService(1);
    const reporter = jest.fn();

    const counts = await service.persist(
      STORE_ID,
      [
        snap('a', { matchKey: 'one|v700|a0' }),
        snap('b', { matchKey: 'two|v700|a0' }),
      ],
      [],
      DAY,
      reporter,
    );

    expect(counts.stored).toBe(2);
    expect(counts.added).toBe(2);
    expect(counts.addedProducts).toBe(2);
    expect(reporter).toHaveBeenCalledWith({
      kind: 'persisted',
      stored: 2,
      added: 2,
      addedProducts: 2,
      removed: 3,
    });
  });
});

describe('ScrapePersistService — what may be written to a bottling', () => {
  it('offers only the fill-if-null fields, once per bottling', async () => {
    const { service, products } = makeService(1);

    await service.persist(
      STORE_ID,
      [
        snap('a', { matchKey: 'one|v700|a0', abv: 40, ageYears: 12 }),
        snap('b', { matchKey: 'one|v700|a0', abv: 43 }),
      ],
      [],
      DAY,
    );

    expect(products.fillMissing).toHaveBeenCalledWith([{
      id: 'product-1',
      abv: 40,
      brandId: null,
      typeId: null,
      countryId: null,
    }]);
  });

  it('adds keyword flavors in one batch and never deletes any', async () => {
    const { service, products } = makeService(
      1,
      new Map([['smoky', 'flavor-1'], ['sherry', 'flavor-2']]),
    );

    await service.persist(
      STORE_ID,
      [snap('a', { flavorTags: ['sherry', 'smoky'] })],
      [],
      DAY,
    );

    expect(products.addScrapeFlavors).toHaveBeenCalledWith([
      { productId: 'product-1', flavorId: 'flavor-1' },
      { productId: 'product-1', flavorId: 'flavor-2' },
    ]);
    expect(products).not.toHaveProperty('setFlavors');
  });

  it('writes the LLM answer once per bottling', async () => {
    const { service, products } = makeService(
      1,
      new Map([['sherry', 'flavor-2']]),
    );

    const answered = {
      matchKey: 'one|v700|a0',
      llmFlavorTags: ['sherry'],
      llmFlavorChecked: true,
    };

    await service.persist(
      STORE_ID,
      [snap('a', answered), snap('b', answered)],
      [],
      DAY,
    );

    expect(products.setLlmFlavors).toHaveBeenCalledTimes(1);
    expect(products.setLlmFlavors)
      .toHaveBeenCalledWith('product-1', ['flavor-2']);
  });

  it('stamps an unknown answer with no tags at all', async () => {
    const { service, products } = makeService(1);

    await service.persist(
      STORE_ID,
      [snap('a', {
        llmFlavorTags: [],
        llmFlavorConfidence: 'unknown',
        llmFlavorChecked: true,
      })],
      [],
      DAY,
    );

    expect(products.setLlmFlavors).toHaveBeenCalledWith('product-1', []);
  });

  it('leaves the classification alone when unanswered', async () => {
    const { service, products } = makeService(1);

    await service.persist(STORE_ID, [snap('a')], [], DAY);

    expect(products.setLlmFlavors).not.toHaveBeenCalled();
  });

  it("writes today's price against the offer, not the bottling", async () => {
    const { service, snapshots } = makeService(1);

    await service.persist(STORE_ID, [snap('a', { price: 999 })], [], DAY);

    expect(snapshots.upsertForDate).toHaveBeenCalledWith(
      'offer-a',
      DAY,
      expect.objectContaining({ price: 999 }),
    );
  });
});
