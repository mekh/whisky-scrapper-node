import 'reflect-metadata';

import { ScrapePersistService } from '../../src/scrape/persist/scrape-persist.service';

import type { CoreBrandService } from '~core/brand';
import type { CoreCountryService } from '~core/country';
import type { CoreFlavorService } from '~core/flavor';
import type { CorePriceSnapshotService } from '~core/price-snapshot';
import type { CoreProductService } from '~core/product';
import type { CoreTypeService } from '~core/type';
import type { ProductSnapshot } from '~types';

/**
 * The persist path is exercised without a database: the transaction wrapper
 * is stubbed out and every core service is a mock. Only the out-of-stock
 * flagging decision (sweep vs guarded fallback) is under test here; the write
 * path itself is covered by the persistence integration spec.
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
  countByStore: jest.Mock;
  upsertFromScrape: jest.Mock;
  setFlavors: jest.Mock;
  setLlmFlavors: jest.Mock;
  markOutOfStockExcept: jest.Mock;
  markOutOfStockBySkus: jest.Mock;
}

function makeService(
  inStockBefore: number,
  names: Map<string, string> = new Map<string, string>(),
): {
  service: ScrapePersistService;
  products: ProductMocks;
} {
  const lookups = {
    resolveByName: jest.fn().mockResolvedValue(names),
    resolveByNameUa: jest.fn().mockResolvedValue(new Map<string, string>()),
  };

  const products = {
    countByStore: jest.fn().mockResolvedValue(inStockBefore),
    upsertFromScrape: jest.fn().mockResolvedValue({
      id: 'product-1',
      isNew: false,
    }),
    setFlavors: jest.fn().mockResolvedValue(undefined),
    setLlmFlavors: jest.fn().mockResolvedValue(undefined),
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
    snapshots as unknown as CorePriceSnapshotService,
  );

  return { service, products };
}

describe('ScrapePersistService.persist', () => {
  it('sweeps everything not seen in stock on a healthy run', async () => {
    const { service, products } = makeService(4);

    const counts = await service.persist(
      STORE_ID,
      [snap('a'), snap('b')],
      ['gone'],
      DAY,
    );

    expect(products.markOutOfStockExcept).toHaveBeenCalledWith(
      STORE_ID,
      ['a', 'b'],
    );
    expect(products.markOutOfStockBySkus).not.toHaveBeenCalled();
    expect(counts.removed).toBe(3);
  });

  it('skips the sweep when the listing looks truncated', async () => {
    const { service, products } = makeService(10);

    const counts = await service.persist(
      STORE_ID,
      [snap('a'), snap('b')],
      ['gone'],
      DAY,
    );

    expect(products.markOutOfStockExcept).not.toHaveBeenCalled();
    expect(products.markOutOfStockBySkus).toHaveBeenCalledWith(
      STORE_ID,
      ['gone'],
    );
    expect(counts.removed).toBe(1);
  });

  it('sweeps an empty store without tripping the guard', async () => {
    const { service, products } = makeService(0);

    await service.persist(STORE_ID, [], [], DAY);

    expect(products.markOutOfStockExcept).toHaveBeenCalledWith(STORE_ID, []);
    expect(products.markOutOfStockBySkus).not.toHaveBeenCalled();
  });

  it('writes the extracted name and keeps the raw one alongside', async () => {
    const { service, products } = makeService(1);
    const item = snap('a');

    item.name = 'Віскі Aberlour 12 років 40% 0,7л';
    item.cleanName = 'Aberlour';

    await service.persist(STORE_ID, [item], [], DAY);

    expect(products.upsertFromScrape).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Aberlour',
        nameOrig: 'Віскі Aberlour 12 років 40% 0,7л',
      }),
      false,
    );
  });

  it(
    'falls back to the deterministic cleanup with no extracted name',
    async () => {
      const { service, products } = makeService(1);
      const item = snap('a');

      item.name = 'Віскі Aberlour 12 років 40% 0,7л';

      await service.persist(STORE_ID, [item], [], DAY);

      expect(products.upsertFromScrape).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Aberlour' }),
        false,
      );
    },
  );

  it('passes the backfill flag down to the upsert', async () => {
    const { service, products } = makeService(1);

    await service.persist(STORE_ID, [snap('a')], [], DAY, true);

    expect(products.upsertFromScrape).toHaveBeenCalledWith(
      expect.anything(),
      true,
    );
  });

  it('writes LLM flavors separately from the keyword ones', async () => {
    const { service, products } = makeService(
      1,
      new Map([['smoky', 'flavor-1'], ['sherry', 'flavor-2']]),
    );

    const item = snap('a', {
      flavorTags: ['smoky'],
      llmFlavorTags: ['sherry'],
      llmFlavorChecked: true,
    });

    await service.persist(STORE_ID, [item], [], DAY);

    expect(products.setFlavors).toHaveBeenCalledWith('product-1', ['flavor-1']);
    expect(products.setLlmFlavors)
      .toHaveBeenCalledWith('product-1', ['flavor-2']);
  });

  it('stamps an unknown answer with no tags at all', async () => {
    const { service, products } = makeService(1);

    const item = snap('a', {
      llmFlavorTags: [],
      llmFlavorConfidence: 'unknown',
      llmFlavorChecked: true,
    });

    await service.persist(STORE_ID, [item], [], DAY);

    expect(products.setLlmFlavors).toHaveBeenCalledWith('product-1', []);
  });

  it('leaves LLM flavors alone when the pass did not answer', async () => {
    const { service, products } = makeService(1);

    await service.persist(STORE_ID, [snap('a')], [], DAY);

    expect(products.setFlavors).toHaveBeenCalled();
    expect(products.setLlmFlavors).not.toHaveBeenCalled();
  });
});
