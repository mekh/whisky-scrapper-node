import 'reflect-metadata';

import { CorePriceSnapshotService } from '~core/price-snapshot';
import { CoreStoreProductService } from '~core/store-product';
import { ReportKind, ReportWindow, SortOrder } from '~enums';
import type {
  ID,
  ReportCurrentRow,
  ReportFilter,
  ReportGroup,
  ReportOptions,
} from '~types';

import { ReportService } from '../src/domain/report/report.service';

const FILTER: ReportFilter = {};

const OPTIONS: ReportOptions = {
  window: ReportWindow.WEEK,
  order: SortOrder.ASC,
  page: 1,
  perPage: 50,
};

/**
 * Builds a full `ReportCurrentRow` from a handful of overrides, so each test
 * only states the fields it actually cares about (prices, mostly).
 *
 * @param over - Fields to override on the default row shape.
 * @returns A complete current row.
 */
function makeRow(over: Partial<ReportCurrentRow>): ReportCurrentRow {
  return {
    id: 'p1' as ID,
    productId: 'b1' as ID,
    sku: 'sku-1',
    url: 'https://example.test/whisky',
    name: 'Whisky Sample 0.7l',
    nameOrig: 'Віскі Whisky Sample 0.7l',
    age: null,
    abv: null,
    volumeMl: 700,
    storeSlug: 'store',
    storeName: 'Store',
    brand: null,
    type: null,
    countryCode: null,
    countryName: null,
    countryIcon: null,
    price: 1000,
    oldPrice: null,
    currency: 'UAH',
    inStock: true,
    promo: false,
    previousPrice: null,
    capturedDate: '2026-07-21',
    firstSeen: '2026-06-15',
    flavors: [],
    ...over,
  };
}

/**
 * Runs a report kind against a fake product service seeded with the given
 * current rows and (for `drops`) per-product price extremes and price-since
 * dates.
 *
 * @param kind - The report kind to run.
 * @param rows - The current rows the fake service returns.
 * @param extremes - Optional product id → window min/max price map.
 * @param priceSince - Optional product id → current-price-since date map
 *   (drives `daysDiscount`).
 * @param today - Optional fixed "today" (`YYYY-MM-DD`) so day-count assertions
 *   are deterministic; when omitted the real current date is used.
 * @param options - Report options to override on top of the defaults.
 * @returns The report groups (page data) the service produced.
 */
async function run(
  kind: ReportKind,
  rows: ReportCurrentRow[],
  extremes?: Map<ID, { min: number; max: number }>,
  priceSince?: Map<ID, string>,
  today?: string,
  options?: Partial<ReportOptions>,
): Promise<ReportGroup[]> {
  const offers = {
    findCurrentRows: jest.fn().mockResolvedValue(rows),
  };

  const snapshots = {
    latestDate: jest.fn().mockResolvedValue('2026-07-21'),
    priceExtremes: jest.fn().mockResolvedValue(extremes ?? new Map()),
    currentPriceSince: jest.fn().mockResolvedValue(priceSince ?? new Map()),
  };

  const service = new ReportService(
    offers as unknown as CoreStoreProductService,
    snapshots as unknown as CorePriceSnapshotService,
  );

  if (today !== undefined) {
    jest
      .spyOn(service as unknown as { today: () => string }, 'today')
      .mockReturnValue(today);
  }

  const page = await service.report(kind, FILTER, { ...OPTIONS, ...options });

  return page.data;
}

describe('ReportService — catalog discount semantics', () => {
  it('never fabricates a discount from the store strike price', async () => {
    // The real "Ardbeg TEN" case: the store advertises a permanent 3090
    // strike price, but our tracked price has always been 2659.
    const rows = [
      makeRow({ price: 2659, oldPrice: 3090, previousPrice: 2659 }),
    ];

    const [row] = await run(ReportKind.CATALOG, rows);

    expect(row.discountPct).toBeNull();
    expect(row.referencePrice).toBeNull();
    expect(row.oldPrice).toBe(3090);
  });

  it('ignores oldPrice when there is no previous snapshot', async () => {
    const rows = [
      makeRow({ price: 2659, oldPrice: 3090, previousPrice: null }),
    ];

    const [row] = await run(ReportKind.CATALOG, rows);

    expect(row.discountPct).toBeNull();
    expect(row.referencePrice).toBeNull();
  });

  it('reports a discount when the tracked price actually dropped', async () => {
    const rows = [
      makeRow({ price: 2000, previousPrice: 2500, oldPrice: null }),
    ];

    const [row] = await run(ReportKind.CATALOG, rows);

    expect(row.referencePrice).toBe(2500);
    expect(row.discountPct).toBe(20);
  });

  it('keeps every row (catalog never filters on discount)', async () => {
    const rows = [
      makeRow({
        id: 'a' as ID,
        productId: 'b1' as ID,
        name: 'A',
        price: 2659,
        previousPrice: 2659,
      }),
      makeRow({
        id: 'b' as ID,
        productId: 'b2' as ID,
        name: 'B',
        price: 2000,
        previousPrice: 2500,
      }),
    ];

    const data = await run(ReportKind.CATALOG, rows);

    expect(data).toHaveLength(2);
  });
});

describe('ReportService — drops discount semantics', () => {
  it('excludes a permanent strike-price anchor with no real drop', async () => {
    const rows = [makeRow({ price: 2659, oldPrice: 3090 })];
    const extremes = new Map([['p1' as ID, { min: 2659, max: 2659 }]]);

    const data = await run(ReportKind.DROPS, rows, extremes);

    expect(data).toHaveLength(0);
  });

  it('includes a product below its observed window maximum', async () => {
    const rows = [makeRow({ price: 2000, oldPrice: null })];
    const extremes = new Map([['p1' as ID, { min: 2000, max: 2500 }]]);

    const [row] = await run(ReportKind.DROPS, rows, extremes);

    expect(row.referencePrice).toBe(2500);
    expect(row.discountPct).toBe(20);
  });
});

describe('ReportService — drops discount age', () => {
  const extremes = new Map([['p1' as ID, { min: 2000, max: 2500 }]]);

  it('ages the current price from when it stopped being higher', async () => {
    const rows = [makeRow({ price: 2000 })];
    const priceSince = new Map([['p1' as ID, '2026-07-18']]);

    const [row] = await run(
      ReportKind.DROPS,
      rows,
      extremes,
      priceSince,
      '2026-07-21',
    );

    expect(row.daysDiscount).toBe(3);
  });

  it('reports a price that dropped today as zero days', async () => {
    const rows = [makeRow({ price: 2000 })];
    const priceSince = new Map([['p1' as ID, '2026-07-21']]);

    const [row] = await run(
      ReportKind.DROPS,
      rows,
      extremes,
      priceSince,
      '2026-07-21',
    );

    expect(row.daysDiscount).toBe(0);
  });

  it('leaves the discount age null when history is missing', async () => {
    const rows = [makeRow({ price: 2000 })];

    const [row] = await run(ReportKind.DROPS, rows, extremes);

    expect(row.daysDiscount).toBeNull();
  });
});

describe('ReportService — drops discount window', () => {
  const TODAY = '2026-07-21';

  const extremes = new Map([
    ['fresh' as ID, { min: 2000, max: 2500 }],
    ['stale' as ID, { min: 2000, max: 2500 }],
  ]);

  const priceSince = new Map([
    ['fresh' as ID, TODAY],
    ['stale' as ID, '2026-07-20'],
  ]);

  /**
   * Two different bottlings, so the window assertions below read one group per
   * row: two offers of the *same* bottling would collapse into one item, which
   * is the point of the grouping tests further down.
   */
  const rows = [
    makeRow({ id: 'fresh' as ID, productId: 'b-fresh' as ID, price: 2000 }),
    makeRow({ id: 'stale' as ID, productId: 'b-stale' as ID, price: 2000 }),
  ];

  /**
   * Runs the `drops` report over the two rows above with a discount window.
   *
   * @param discountWindow - The window to narrow by, or undefined for all.
   * @returns The ids of the rows the report kept, in order.
   */
  async function ids(discountWindow?: ReportWindow): Promise<ID[]> {
    const data = await run(
      ReportKind.DROPS,
      rows,
      extremes,
      priceSince,
      TODAY,
      { discountWindow },
    );

    return data.map((row) => row.id);
  }

  it('keeps every drop when no window is requested', async () => {
    expect(await ids()).toEqual(['fresh', 'stale']);
  });

  it('keeps only prices that dropped today', async () => {
    expect(await ids(ReportWindow.TODAY)).toEqual(['fresh']);
  });

  it('keeps only prices that dropped yesterday', async () => {
    expect(await ids(ReportWindow.YESTERDAY)).toEqual(['stale']);
  });

  it('ignores a period window, which means the lookback here', async () => {
    expect(await ids(ReportWindow.MONTH)).toEqual(['fresh', 'stale']);
  });

  it('excludes a row whose discount age is unknown', async () => {
    const data = await run(
      ReportKind.DROPS,
      rows,
      extremes,
      new Map([['stale' as ID, '2026-07-20']]),
      TODAY,
      { discountWindow: ReportWindow.TODAY },
    );

    expect(data).toHaveLength(0);
  });
});

/**
 * Runs the `best` report under a price filter, reporting both the groups it
 * produced and the filter the repository was actually asked for — the second
 * is what pins the price bounds to the winner instead of to the candidates.
 *
 * @param rows - The current rows the fake repository returns.
 * @param filter - The report filter to run with.
 * @returns The report groups and the filter `findCurrentRows` received.
 */
async function runBest(
  rows: ReportCurrentRow[],
  filter: ReportFilter,
): Promise<{ data: ReportGroup[]; selected: ReportFilter }> {
  const findCurrentRows = jest.fn<Promise<ReportCurrentRow[]>, [ReportFilter]>()
    .mockResolvedValue(rows);

  const snapshots = {
    latestDate: jest.fn().mockResolvedValue('2026-07-21'),
    priceExtremes: jest.fn().mockResolvedValue(new Map()),
    currentPriceSince: jest.fn().mockResolvedValue(new Map()),
  };

  const service = new ReportService(
    { findCurrentRows } as unknown as CoreStoreProductService,
    snapshots as unknown as CorePriceSnapshotService,
  );

  const page = await service.report(ReportKind.BEST, filter, OPTIONS);

  return { data: page.data, selected: findCurrentRows.mock.calls[0][0] };
}

describe('ReportService — best offers group by the stored bottling', () => {
  it('returns the cheapest offer, against the runner-up', async () => {
    const rows = [
      makeRow({ id: 'a' as ID, storeSlug: 'one', price: 1200 }),
      makeRow({ id: 'b' as ID, storeSlug: 'two', price: 1000 }),
      makeRow({ id: 'c' as ID, storeSlug: 'three', price: 1500 }),
    ];

    const [row] = await run(ReportKind.BEST, rows);

    /**
     * The id stays the winning offer's, because that is what the client deep
     * links and asks for a price history.
     */
    expect(row.id).toBe('b');
    expect(row.price).toBe(1000);
    expect(row.referencePrice).toBe(1200);
  });

  it('needs two stores, not two listings from one', async () => {
    const rows = [
      makeRow({ id: 'a' as ID, storeSlug: 'one', price: 1000 }),
      makeRow({ id: 'b' as ID, storeSlug: 'one', price: 1400 }),
    ];

    expect(await run(ReportKind.BEST, rows)).toHaveLength(0);
  });

  it('drops a group whose winner is implausibly cheap', async () => {
    const rows = [
      makeRow({ id: 'a' as ID, storeSlug: 'one', price: 400 }),
      makeRow({ id: 'b' as ID, storeSlug: 'two', price: 1000 }),
    ];

    expect(await run(ReportKind.BEST, rows)).toHaveLength(0);
  });

  it('keeps a group exactly at the guard boundary', async () => {
    const rows = [
      makeRow({ id: 'a' as ID, storeSlug: 'one', price: 500 }),
      makeRow({ id: 'b' as ID, storeSlug: 'two', price: 1000 }),
    ];

    expect(await run(ReportKind.BEST, rows)).toHaveLength(1);
  });

  it('never merges two bottlings that merely read alike', async () => {
    /**
     * Same name, same brand, same size — and still two different whiskies.
     * Identity is the persisted link, so the report cannot second-guess it;
     * the old token key merged exactly this case.
     */
    const rows = [
      makeRow({ id: 'a' as ID, productId: 'b1' as ID, storeSlug: 'one' }),
      makeRow({ id: 'b' as ID, productId: 'b2' as ID, storeSlug: 'two' }),
    ];

    expect(await run(ReportKind.BEST, rows)).toHaveLength(0);
  });

  it('compares packaging variants of one bottling', async () => {
    const rows = [
      makeRow({
        id: 'a' as ID,
        storeSlug: 'one',
        nameOrig: 'Віскі Aberlour 0,7л в коробці',
        price: 1200,
      }),
      makeRow({
        id: 'b' as ID,
        storeSlug: 'two',
        nameOrig: 'Віскі Aberlour 0,7л',
        price: 1000,
      }),
    ];

    const [row] = await run(ReportKind.BEST, rows);

    expect(row.id).toBe('b');
    expect(row.referencePrice).toBe(1200);
  });

  it('includes a bottling whose size is unknown', async () => {
    /**
     * These used to be dropped outright, because the report's own key put the
     * volume in the signature and a `v0` group could not be trusted. A stored
     * bottling is one curated product whatever its size.
     */
    const rows = [
      makeRow({ id: 'a' as ID, storeSlug: 'one', volumeMl: null, price: 1200 }),
      makeRow({ id: 'b' as ID, storeSlug: 'two', volumeMl: null, price: 1000 }),
    ];

    expect(await run(ReportKind.BEST, rows)).toHaveLength(1);
  });

  it('carries the winning offer alone', async () => {
    const rows = [
      makeRow({ id: 'a' as ID, storeSlug: 'one', price: 1200 }),
      makeRow({ id: 'b' as ID, storeSlug: 'two', price: 1000 }),
    ];

    const [group] = await run(ReportKind.BEST, rows);

    expect(group.offers).toHaveLength(1);
    expect(group.offers[0].id).toBe('b');
  });

  it('keeps a winner whose runner-up is above the price ceiling', async () => {
    /**
     * The real "Glenfiddich Triple Oak" case: 1699 at rozetka against 3299 at
     * maudau. Filtering the price in SQL took the runner-up out of the group,
     * the group fell under the two-store guard, and the affordable offer the
     * user was filtering *for* disappeared from `maxPrice=2000`.
     */
    const rows = [
      makeRow({ id: 'a' as ID, storeSlug: 'rozetka', price: 1699 }),
      makeRow({ id: 'b' as ID, storeSlug: 'maudau', price: 3299 }),
    ];

    const { data, selected } = await runBest(rows, { maxPrice: 2000 });

    expect(selected.maxPrice).toBeUndefined();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('a');
    expect(data[0].price).toBe(1699);
    expect(data[0].referencePrice).toBe(3299);
  });

  it('measures the saving against the true runner-up', async () => {
    /**
     * With the ceiling applied in SQL the 2500 offer was invisible, so the
     * winner's saving read as 20% off 2000 rather than 36% off the cheapest
     * price anyone else actually asks.
     */
    const rows = [
      makeRow({ id: 'a' as ID, storeSlug: 'one', price: 1600 }),
      makeRow({ id: 'b' as ID, storeSlug: 'two', price: 2500 }),
      makeRow({ id: 'c' as ID, storeSlug: 'three', price: 2000 }),
    ];

    const { data } = await runBest(rows, { maxPrice: 2000 });

    expect(data).toHaveLength(1);
    expect(data[0].referencePrice).toBe(2000);
    expect(data[0].discountPct).toBe(20);
  });

  it('drops a winner priced outside the bounds', async () => {
    const rows = [
      makeRow({ id: 'a' as ID, storeSlug: 'one', price: 2400 }),
      makeRow({ id: 'b' as ID, storeSlug: 'two', price: 3000 }),
    ];

    const above = await runBest(rows, { maxPrice: 2000 });
    const below = await runBest(rows, { minPrice: 2500 });

    expect(above.data).toHaveLength(0);
    expect(below.data).toHaveLength(0);
  });

  it('leaves every other predicate to SQL', async () => {
    const filter: ReportFilter = {
      stores: ['one', 'two'],
      minPrice: 100,
      maxPrice: 2000,
      countries: ['gb'],
      name: 'glen',
    };

    const { selected } = await runBest([], filter);

    expect(selected).toEqual({
      ...filter,
      minPrice: undefined,
      maxPrice: undefined,
    });
  });
});

describe('ReportService — catalog groups the offers of one bottling', () => {
  /**
   * Three stores carrying the same whisky at different prices, plus an
   * unrelated bottling — the shape the flat report used to spread over four
   * rows.
   *
   * @returns The seeded current rows.
   */
  function threeStores(): ReportCurrentRow[] {
    return [
      makeRow({
        id: 'mid' as ID,
        storeSlug: 'two',
        storeName: 'Two',
        price: 1200,
      }),
      makeRow({
        id: 'cheap' as ID,
        storeSlug: 'one',
        storeName: 'One',
        price: 1000,
      }),
      makeRow({
        id: 'dear' as ID,
        storeSlug: 'three',
        storeName: 'Three',
        price: 1500,
      }),
    ];
  }

  it('returns one item per bottling, whatever the store count', async () => {
    const data = await run(ReportKind.CATALOG, threeStores());

    expect(data).toHaveLength(1);
    expect(data[0].offers).toHaveLength(3);
  });

  it('orders the offers cheapest first', async () => {
    const [group] = await run(ReportKind.CATALOG, threeStores());

    expect(group.offers.map((offer) => offer.price)).toEqual([
      1000,
      1200,
      1500,
    ]);
  });

  it('leads with the cheapest offer', async () => {
    const [group] = await run(ReportKind.CATALOG, threeStores());

    expect(group.id).toBe('cheap');
    expect(group.price).toBe(1000);
    expect(group.storeName).toBe('One');
    expect(group.offers[0].id).toBe(group.id);
  });

  it('states the bottling once, not once per store', async () => {
    const [group] = await run(ReportKind.CATALOG, threeStores());
    const [offer] = group.offers;

    expect(offer).not.toHaveProperty('productId');
    expect(offer).not.toHaveProperty('name');
    expect(offer).not.toHaveProperty('flavors');
    expect(offer).not.toHaveProperty('age');
    expect(group.name).toBe('Whisky Sample 0.7l');
  });

  it('separates two bottlings', async () => {
    const rows = [
      makeRow({ id: 'a' as ID, productId: 'b1' as ID, name: 'A' }),
      makeRow({ id: 'b' as ID, productId: 'b2' as ID, name: 'B' }),
    ];

    const page = await run(ReportKind.CATALOG, rows);

    expect(page).toHaveLength(2);
  });

  it('picks the same primary offer for equally priced offers', async () => {
    const rows = [
      makeRow({ id: 'a' as ID, storeSlug: 'one', storeName: 'One' }),
      makeRow({ id: 'b' as ID, storeSlug: 'two', storeName: 'Two' }),
    ];

    const [forward] = await run(ReportKind.CATALOG, rows);
    const [reversed] = await run(ReportKind.CATALOG, [...rows].reverse());

    expect(forward.id).toBe(reversed.id);
    expect(forward.offers.map((offer) => offer.id))
      .toEqual(reversed.offers.map((offer) => offer.id));
  });
});

describe('ReportService — new and drops group only what qualified', () => {
  const TODAY = '2026-07-21';

  it('lists only the stores that just started carrying it', async () => {
    const rows = [
      makeRow({ id: 'fresh' as ID, storeSlug: 'new-store', firstSeen: TODAY }),
      makeRow({
        id: 'old' as ID,
        storeSlug: 'old-store',
        firstSeen: '2026-01-01',
      }),
    ];

    const data = await run(ReportKind.NEW, rows, undefined, undefined, TODAY);

    expect(data).toHaveLength(1);
    expect(data[0].offers.map((offer) => offer.id)).toEqual(['fresh']);
  });

  it('narrows a group by the added-on window', async () => {
    const rows = [
      makeRow({ id: 'today' as ID, storeSlug: 'one', firstSeen: TODAY }),
      makeRow({
        id: 'yesterday' as ID,
        storeSlug: 'two',
        firstSeen: '2026-07-20',
      }),
    ];

    const data = await run(
      ReportKind.NEW,
      rows,
      undefined,
      undefined,
      TODAY,
      { window: ReportWindow.TODAY },
    );

    expect(data[0].offers.map((offer) => offer.id)).toEqual(['today']);
  });

  it('groups every discounted offer of one bottling', async () => {
    const rows = [
      makeRow({ id: 'a' as ID, storeSlug: 'one', price: 2000 }),
      makeRow({ id: 'b' as ID, storeSlug: 'two', price: 2200 }),
    ];

    const extremes = new Map([
      ['a' as ID, { min: 2000, max: 2500 }],
      ['b' as ID, { min: 2200, max: 2500 }],
    ]);

    const data = await run(ReportKind.DROPS, rows, extremes);

    expect(data).toHaveLength(1);
    expect(data[0].offers.map((offer) => offer.id)).toEqual(['a', 'b']);
  });

  it('leads with the cheapest drop, not the deepest one', async () => {
    /**
     * 1000 at −10 % beats 1100 at −15 %: a user comparing offers is choosing
     * what to pay. The deeper cut is still visible inside the group.
     */
    const rows = [
      makeRow({ id: 'cheaper' as ID, storeSlug: 'one', price: 1000 }),
      makeRow({ id: 'deeper' as ID, storeSlug: 'two', price: 1100 }),
    ];

    const extremes = new Map([
      ['cheaper' as ID, { min: 1000, max: 1111 }],
      ['deeper' as ID, { min: 1100, max: 1294 }],
    ]);

    const [group] = await run(ReportKind.DROPS, rows, extremes);

    expect(group.id).toBe('cheaper');
    expect(group.discountPct).toBe(10);
    expect(group.offers[1].discountPct).toBe(15);
  });

  it('drops offers below the minimum discount, keeping the rest', async () => {
    const rows = [
      makeRow({ id: 'deep' as ID, storeSlug: 'one', price: 2000 }),
      makeRow({ id: 'shallow' as ID, storeSlug: 'two', price: 2450 }),
    ];

    const extremes = new Map([
      ['deep' as ID, { min: 2000, max: 2500 }],
      ['shallow' as ID, { min: 2450, max: 2500 }],
    ]);

    const data = await run(
      ReportKind.DROPS,
      rows,
      extremes,
      undefined,
      undefined,
      { minDiscount: 10 },
    );

    expect(data).toHaveLength(1);
    expect(data[0].offers.map((offer) => offer.id)).toEqual(['deep']);
  });
});

describe('ReportService — low keeps one item per qualifying offer', () => {
  it('reports two stores at their own window low separately', async () => {
    const rows = [
      makeRow({
        id: 'a' as ID,
        storeSlug: 'one',
        price: 1000,
        previousPrice: 1200,
      }),
      makeRow({
        id: 'b' as ID,
        storeSlug: 'two',
        price: 1100,
        previousPrice: 1300,
      }),
    ];

    const extremes = new Map([
      ['a' as ID, { min: 1000, max: 1200 }],
      ['b' as ID, { min: 1100, max: 1300 }],
    ]);

    const data = await run(ReportKind.LOW, rows, extremes);

    expect(data).toHaveLength(2);
    expect(data.every((group) => group.offers.length === 1)).toBe(true);
    expect(data.map((group) => group.offers[0].id).sort()).toEqual(['a', 'b']);
  });
});

describe('ReportService — pagination and sorting count groups', () => {
  /**
   * Three bottlings, each carried by two stores: six offers that must page as
   * three items.
   *
   * @returns The seeded current rows.
   */
  function threeBottlings(): ReportCurrentRow[] {
    return ['b1', 'b2', 'b3'].flatMap((productId, index) => [
      makeRow({
        id: `${productId}-cheap` as ID,
        productId: productId as ID,
        name: `Whisky ${productId}`,
        storeSlug: 'one',
        storeName: 'One',
        price: 1000 + index * 100,
        age: index === 0 ? null : 10 + index,
      }),
      makeRow({
        id: `${productId}-dear` as ID,
        productId: productId as ID,
        name: `Whisky ${productId}`,
        storeSlug: 'two',
        storeName: 'Two',
        price: 2000 + index * 100,
        age: index === 0 ? null : 10 + index,
      }),
    ]);
  }

  it('counts bottlings, not offers', async () => {
    const offers = {
      findCurrentRows: jest.fn().mockResolvedValue(threeBottlings()),
    };

    const snapshots = {
      latestDate: jest.fn().mockResolvedValue('2026-07-21'),
      priceExtremes: jest.fn().mockResolvedValue(new Map()),
      currentPriceSince: jest.fn().mockResolvedValue(new Map()),
    };

    const service = new ReportService(
      offers as unknown as CoreStoreProductService,
      snapshots as unknown as CorePriceSnapshotService,
    );

    const page = await service.report(ReportKind.CATALOG, FILTER, {
      ...OPTIONS,
      perPage: 50,
    });

    expect(page.total).toBe(3);
    expect(page.data).toHaveLength(3);
  });

  it('sorts by the primary offer for an offer-level field', async () => {
    const data = await run(
      ReportKind.CATALOG,
      threeBottlings(),
      undefined,
      undefined,
      undefined,
      { sort: 'price' as ReportOptions['sort'], order: SortOrder.DESC },
    );

    expect(data.map((group) => group.price)).toEqual([1200, 1100, 1000]);
  });

  it('sorts by a product field without touching the offers', async () => {
    const data = await run(
      ReportKind.CATALOG,
      threeBottlings(),
      undefined,
      undefined,
      undefined,
      { sort: 'name' as ReportOptions['sort'], order: SortOrder.DESC },
    );

    expect(data.map((group) => group.name)).toEqual([
      'Whisky b3',
      'Whisky b2',
      'Whisky b1',
    ]);

    expect(data[0].offers).toHaveLength(2);
  });

  it('keeps nulls last whichever direction is requested', async () => {
    const ascending = await run(
      ReportKind.CATALOG,
      threeBottlings(),
      undefined,
      undefined,
      undefined,
      { sort: 'age' as ReportOptions['sort'], order: SortOrder.ASC },
    );

    const descending = await run(
      ReportKind.CATALOG,
      threeBottlings(),
      undefined,
      undefined,
      undefined,
      { sort: 'age' as ReportOptions['sort'], order: SortOrder.DESC },
    );

    expect(ascending[ascending.length - 1].age).toBeNull();
    expect(descending[descending.length - 1].age).toBeNull();
  });
});
