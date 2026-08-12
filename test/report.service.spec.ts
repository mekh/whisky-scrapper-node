import 'reflect-metadata';

import { CorePriceSnapshotService } from '~core/price-snapshot';
import { CoreStoreProductService } from '~core/store-product';
import { ReportKind, ReportWindow, SortOrder } from '~enums';
import type {
  ID,
  ReportCurrentRow,
  ReportFilter,
  ReportOptions,
  ReportRow,
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
 * @returns The report rows (page data) the service produced.
 */
async function run(
  kind: ReportKind,
  rows: ReportCurrentRow[],
  extremes?: Map<ID, { min: number; max: number }>,
  priceSince?: Map<ID, string>,
  today?: string,
  options?: Partial<ReportOptions>,
): Promise<ReportRow[]> {
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
      makeRow({ id: 'a' as ID, name: 'A', price: 2659, previousPrice: 2659 }),
      makeRow({ id: 'b' as ID, name: 'B', price: 2000, previousPrice: 2500 }),
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

  const rows = [
    makeRow({ id: 'fresh' as ID, price: 2000 }),
    makeRow({ id: 'stale' as ID, price: 2000 }),
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
});
