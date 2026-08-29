import 'reflect-metadata';

import { FactSource, ListingStop } from '~enums';

import { ScrapePersistService } from '../../src/scrape/persist/scrape-persist.service';

import type { CoreBrandService } from '~core/brand';
import type { CoreCountryService } from '~core/country';
import type { CoreFlavorService } from '~core/flavor';
import type { CorePriceSnapshotService } from '~core/price-snapshot';
import type { CoreProducerService } from '~core/producer';
import type { CoreProductService } from '~core/product';
import type { CoreStoreProductService } from '~core/store-product';
import type { CoreTypeService } from '~core/type';
import type { ListingResult, ProductSnapshot } from '~types';

import type { KbApplyService } from '../../src/scrape/kb/kb-apply.service';

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

/**
 * A walk that reached the end of the store's listing, which is what earns a
 * run the sweep. `items` is unused by persist — it takes the snapshots
 * separately — so it stays empty here.
 */
const COMPLETE: ListingResult = {
  items: [],
  complete: true,
  stop: ListingStop.COUNTED,
  statedItems: null,
};

/**
 * A walk that gave up on a failed page, holding a fragment of the listing.
 */
const INCOMPLETE: ListingResult = {
  items: [],
  complete: false,
  stop: ListingStop.PAGE_FAILED,
  statedItems: null,
};

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
    factSources: {},
    ...over,
  };
}

interface ProductMocks {
  findOrCreateByMatchKeys: jest.Mock;
  createUnmatched: jest.Mock;
  fillMissing: jest.Mock;
  addScrapeFlavors: jest.Mock;
  setLlmFlavors: jest.Mock;
  findFactsByIds: jest.Mock;
  logFactConflicts: jest.Mock;
  findKbReconcileCandidates: jest.Mock;
  setProducers: jest.Mock;
  applyKbFacts: jest.Mock;
  applyKbFlavors: jest.Mock;
}

interface OfferMocks {
  countByStore: jest.Mock;
  existingSkus: jest.Mock;
  upsertFromScrape: jest.Mock;
  markOutOfStockExcept: jest.Mock;
  markOutOfStockBySkus: jest.Mock;
}

interface KbMocks {
  loadIndex: jest.Mock;
  resolveTypeIds: jest.Mock;
  plan: jest.Mock;
}

interface Harness {
  service: ScrapePersistService;
  kb: KbMocks;
  products: ProductMocks;
  offers: OfferMocks;
  snapshots: {
    upsertForDate: jest.Mock;
    markOutOfStockForDay: jest.Mock;
  };
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

  const producers = {
    loadIndex: jest.fn().mockResolvedValue({
      aliases: [{ key: 'x', scope: 'any', producer: { id: 'p1' } }],
      rules: [],
      producerFlavors: new Map(),
      peatFlavorIds: { peated: null, smoky: null },
    }),
    resolveTypeIds: jest.fn().mockResolvedValue(new Map<string, string>()),
  };

  const kbApply = {
    plan: jest.fn().mockReturnValue({
      groups: [],
      resolutions: [],
      producers: [],
      facts: [],
      flavors: [],
    }),
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
    findFactsByIds: jest.fn().mockResolvedValue([]),
    logFactConflicts: jest.fn().mockResolvedValue(undefined),
    findKbReconcileCandidates: jest.fn().mockResolvedValue([]),
    setProducers: jest.fn().mockResolvedValue(0),
    applyKbFacts: jest.fn().mockResolvedValue(0),
    applyKbFlavors: jest.fn().mockResolvedValue(undefined),
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
    markOutOfStockForDay: jest.fn().mockResolvedValue(0),
  };

  const service = new ScrapePersistService(
    lookups as unknown as CoreBrandService,
    lookups as unknown as CoreTypeService,
    lookups as unknown as CoreFlavorService,
    lookups as unknown as CoreCountryService,
    products as unknown as CoreProductService,
    offers as unknown as CoreStoreProductService,
    snapshots as unknown as CorePriceSnapshotService,
    producers as unknown as CoreProducerService,
    kbApply as unknown as KbApplyService,
  );

  return {
    service,
    products,
    offers,
    snapshots,
    kb: { ...producers, plan: kbApply.plan },
  };
}

describe('ScrapePersistService — the out-of-stock sweep', () => {
  it('sweeps everything not seen in stock on a complete listing', async () => {
    const { service, offers } = makeService(4);

    const counts = await service.persist(
      STORE_ID,
      [snap('a'), snap('b')],
      ['gone'],
      DAY,
      COMPLETE,
    );

    expect(offers.markOutOfStockExcept).toHaveBeenCalledWith(
      STORE_ID,
      ['a', 'b'],
    );
    expect(offers.markOutOfStockBySkus).not.toHaveBeenCalled();
    expect(counts.removed).toBe(3);
  });

  /**
   * The case that used to freeze a store. Silpo's whisky category really did
   * fall from 1070 offers to 249 in a day; the old count guard read that as a
   * truncated listing and skipped the sweep, and because its baseline was the
   * live in-stock count that skipping the sweep is what kept from falling,
   * every later run made the same comparison and skipped again.
   */
  it('sweeps a complete listing however far the stock fell', async () => {
    const { service, offers } = makeService(100);

    const counts = await service.persist(
      STORE_ID,
      [snap('a'), snap('b')],
      ['gone'],
      DAY,
      COMPLETE,
    );

    expect(offers.markOutOfStockExcept).toHaveBeenCalledWith(
      STORE_ID,
      ['a', 'b'],
    );
    expect(offers.markOutOfStockBySkus).not.toHaveBeenCalled();
    expect(counts.removed).toBe(3);
  });

  it('still reports a sharp drop, so an operator can look', async () => {
    const { service } = makeService(100);
    const reporter = jest.fn();

    await service.persist(
      STORE_ID,
      [snap('a'), snap('b')],
      ['gone'],
      DAY,
      COMPLETE,
      reporter,
    );

    expect(reporter).toHaveBeenCalledWith({
      kind: 'stock-drop',
      inStock: 2,
      baseline: 100,
    });
  });

  it('leaves a modest drop on a complete listing unremarked', async () => {
    const { service } = makeService(3);
    const reporter = jest.fn();

    await service.persist(
      STORE_ID,
      [snap('a'), snap('b')],
      ['gone'],
      DAY,
      COMPLETE,
      reporter,
    );

    expect(reporter).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'stock-drop' }),
    );
  });

  it('skips the sweep when the walk never reached the end', async () => {
    const { service, offers } = makeService(4);

    const counts = await service.persist(
      STORE_ID,
      [snap('a'), snap('b')],
      ['gone'],
      DAY,
      INCOMPLETE,
    );

    expect(offers.markOutOfStockExcept).not.toHaveBeenCalled();
    expect(offers.markOutOfStockBySkus).toHaveBeenCalledWith(
      STORE_ID,
      ['gone'],
    );
    expect(counts.removed).toBe(1);
  });

  /**
   * The other direction the count guard got wrong: a listing that broke after
   * collecting most of itself cleared the ratio, and the rest of the store was
   * flagged unavailable on what was really a transient failure.
   */
  it('skips the sweep on a fragment that would clear any ratio', async () => {
    const { service, offers } = makeService(2);

    await service.persist(
      STORE_ID,
      [snap('a'), snap('b')],
      ['gone'],
      DAY,
      INCOMPLETE,
    );

    expect(offers.markOutOfStockExcept).not.toHaveBeenCalled();
  });

  it('reports a skipped sweep, which the run log has to show', async () => {
    const { service } = makeService(10);
    const reporter = jest.fn();

    await service.persist(
      STORE_ID,
      [snap('a'), snap('b')],
      ['gone'],
      DAY,
      INCOMPLETE,
      reporter,
    );

    expect(reporter).toHaveBeenCalledWith({
      kind: 'listing-incomplete',
      stop: ListingStop.PAGE_FAILED,
      inStock: 2,
      baseline: 10,
    });
  });

  it('sweeps a store that emptied out entirely', async () => {
    const { service, offers } = makeService(0);

    await service.persist(STORE_ID, [], [], DAY, COMPLETE);

    expect(offers.markOutOfStockExcept).toHaveBeenCalledWith(STORE_ID, []);
    expect(offers.markOutOfStockBySkus).not.toHaveBeenCalled();
  });

  /**
   * The day's snapshots have to state the availability the run ended on, not
   * the one its first pass happened to see: a second run of the same day flags
   * offers the first one wrote rows for, and an out-of-stock offer is never
   * upserted, so nothing else would ever correct those rows.
   */
  it("reconciles the day's snapshots with the sweep's verdict", async () => {
    const { service, snapshots } = makeService(4);

    await service.persist(
      STORE_ID,
      [snap('a'), snap('b')],
      ['gone'],
      DAY,
      COMPLETE,
    );

    expect(snapshots.markOutOfStockForDay).toHaveBeenCalledWith(STORE_ID, DAY);
  });

  it('reconciles the day even when the sweep was skipped', async () => {
    const { service, snapshots } = makeService(4);

    await service.persist(
      STORE_ID,
      [snap('a'), snap('b')],
      ['gone'],
      DAY,
      INCOMPLETE,
    );

    expect(snapshots.markOutOfStockForDay).toHaveBeenCalledWith(STORE_ID, DAY);
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

    await service.persist(STORE_ID, [item], [], DAY, COMPLETE);

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

    await service.persist(STORE_ID, [snap('a')], [], DAY, COMPLETE);

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
      COMPLETE,
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
      COMPLETE,
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
      COMPLETE,
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
      COMPLETE,
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
  it('offers only the fillable fields, once per bottling', async () => {
    const { service, products } = makeService(1);

    await service.persist(
      STORE_ID,
      [
        snap('a', { matchKey: 'one|v700|a0', abv: 40, ageYears: 12 }),
        snap('b', { matchKey: 'one|v700|a0', abv: 43 }),
      ],
      [],
      DAY,
      COMPLETE,
    );

    /**
     * Each value carries the source it came from, which is what decides
     * whether it may correct a stored one rather than only fill a gap. These
     * snapshots go through no normalization here, so persist falls back to
     * `store` — the store is the only party that could have set them.
     */
    expect(products.fillMissing).toHaveBeenCalledWith([{
      id: 'product-1',
      abv: 40,
      brandId: null,
      typeId: null,
      countryId: null,
      abvSource: FactSource.STORE,
      brandSource: FactSource.STORE,
      typeSource: FactSource.STORE,
      countrySource: FactSource.STORE,
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
      COMPLETE,
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
      COMPLETE,
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
      COMPLETE,
    );

    expect(products.setLlmFlavors).toHaveBeenCalledWith('product-1', []);
  });

  it('leaves the classification alone when unanswered', async () => {
    const { service, products } = makeService(1);

    await service.persist(STORE_ID, [snap('a')], [], DAY, COMPLETE);

    expect(products.setLlmFlavors).not.toHaveBeenCalled();
  });

  it("writes today's price against the offer, not the bottling", async () => {
    const { service, snapshots } = makeService(1);

    await service.persist(
      STORE_ID,
      [snap('a', { price: 999 })],
      [],
      DAY,
      COMPLETE,
    );

    expect(snapshots.upsertForDate).toHaveBeenCalledWith(
      'offer-a',
      DAY,
      expect.objectContaining({ price: 999 }),
    );
  });
});

/**
 * The cross-shop contradiction log, written during the scrape.
 *
 * The log has to be written here and nowhere else: `fillMissing` is about to
 * discard whichever value ranks lower and say nothing about it, and `rawAttrs`
 * is never persisted, so this is the last moment at which the stored value and
 * the live claim exist together.
 */
describe('ScrapePersistService: the fact conflict log', () => {
  it('logs a claim that contradicts a stored fact', async () => {
    const { service, products } = makeService(1);

    products.findFactsByIds.mockResolvedValue([{
      id: 'product-1',
      brandId: null,
      typeId: null,
      countryId: null,
      abv: 40,
      brandSource: null,
      typeSource: null,
      countrySource: null,
      abvSource: 'store',
    }]);

    await service.persist(
      STORE_ID,
      [snap('a', { abv: 43 })],
      [],
      DAY,
      COMPLETE,
    );

    expect(products.logFactConflicts).toHaveBeenCalledWith([{
      productId: 'product-1',
      storeId: STORE_ID,
      attribute: 'abv',
      storedValue: '40',
      claimedValue: '43',
      storedSource: 'store',
    }]);
  });

  it('ignores a strength difference inside the tolerance', async () => {
    const { service, products } = makeService(1);

    products.findFactsByIds.mockResolvedValue([{
      id: 'product-1',
      brandId: null,
      typeId: null,
      countryId: null,
      abv: 40,
      brandSource: null,
      typeSource: null,
      countrySource: null,
      abvSource: 'store',
    }]);

    await service.persist(
      STORE_ID,
      [snap('a', { abv: 40.05 })],
      [],
      DAY,
      COMPLETE,
    );

    expect(products.logFactConflicts).toHaveBeenCalledWith([]);
  });

  it('does not treat a stored gap as a disagreement', async () => {
    const { service, products } = makeService(1);

    products.findFactsByIds.mockResolvedValue([{
      id: 'product-1',
      brandId: null,
      typeId: null,
      countryId: null,
      abv: null,
      brandSource: null,
      typeSource: null,
      countrySource: null,
      abvSource: null,
    }]);

    await service.persist(
      STORE_ID,
      [snap('a', { abv: 43 })],
      [],
      DAY,
      COMPLETE,
    );

    expect(products.logFactConflicts).toHaveBeenCalledWith([]);
  });

  it('logs before the value that loses is discarded', async () => {
    const { service, products } = makeService(1);

    const order: string[] = [];

    products.logFactConflicts.mockImplementation(() => {
      order.push('log');

      return Promise.resolve();
    });

    products.fillMissing.mockImplementation(() => {
      order.push('fill');

      return Promise.resolve(0);
    });

    await service.persist(STORE_ID, [snap('a')], [], DAY, COMPLETE);

    expect(order).toEqual(['log', 'fill']);
  });

  it('never fails a sync because the log could not be written', async () => {
    const { service, products } = makeService(1);

    products.findFactsByIds.mockRejectedValue(new Error('log is down'));

    await expect(
      service.persist(STORE_ID, [snap('a')], [], DAY, COMPLETE),
    ).resolves.toMatchObject({ stored: 1 });
  });
});

/**
 * The knowledge-base pass inside a sync.
 *
 * Without it the catalogue is only right until the next cron: every sync
 * re-derives tags from listings and model answers, quietly re-creating the
 * errors the reconciliation pass corrected. Its position in `persist` is what
 * makes the repair durable, so the order is asserted rather than assumed.
 */
describe('ScrapePersistService: the knowledge-base pass', () => {
  it('runs after the scrape and LLM flavors are written', async () => {
    const { service, products, kb } = makeService(1);

    const order: string[] = [];

    products.setLlmFlavors.mockImplementation(() => {
      order.push('llm');

      return Promise.resolve();
    });

    products.addScrapeFlavors.mockImplementation(() => {
      order.push('scrape');

      return Promise.resolve();
    });

    kb.plan.mockImplementation(() => {
      order.push('kb');

      return {
        groups: [],
        resolutions: [],
        producers: [],
        facts: [],
        flavors: [],
      };
    });

    await service.persist(
      STORE_ID,
      [snap('a', { llmFlavorTags: ['sherry'], llmFlavorChecked: true })],
      [],
      DAY,
      COMPLETE,
    );

    expect(order).toEqual(['llm', 'scrape', 'kb']);
  });

  it('applies the plan to the bottlings the run touched', async () => {
    const { service, products, kb } = makeService(1);

    kb.plan.mockReturnValue({
      groups: [{ key: 'x', name: 'X', rows: [] }],
      resolutions: [{ producer: null }],
      producers: [{ productId: 'product-1' }],
      facts: [{ productId: 'product-1' }],
      flavors: [{
        productId: 'product-1',
        insertFlavorIds: ['flavor-1'],
        deleteFlavorIds: [],
      }],
    });

    await service.persist(STORE_ID, [snap('a')], [], DAY, COMPLETE);

    expect(products.setProducers).toHaveBeenCalled();
    expect(products.applyKbFacts).toHaveBeenCalled();
    expect(products.applyKbFlavors).toHaveBeenCalledWith([{
      productId: 'product-1',
      insertFlavorIds: ['flavor-1'],
      deleteFlavorIds: [],
    }]);
  });

  it('skips the pass entirely when the knowledge base is empty', async () => {
    const { service, products, kb } = makeService(1);

    kb.loadIndex.mockResolvedValue({
      aliases: [],
      rules: [],
      producerFlavors: new Map(),
      peatFlavorIds: { peated: null, smoky: null },
    });

    await service.persist(STORE_ID, [snap('a')], [], DAY, COMPLETE);

    expect(products.setProducers).not.toHaveBeenCalled();
  });

  it('never fails a sync because the knowledge base failed', async () => {
    const { service, kb } = makeService(1);

    kb.loadIndex.mockRejectedValue(new Error('knowledge base is down'));

    await expect(
      service.persist(STORE_ID, [snap('a')], [], DAY, COMPLETE),
    ).resolves.toMatchObject({ stored: 1 });
  });
});
