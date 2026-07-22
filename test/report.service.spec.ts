import 'reflect-metadata';

import { CoreProductService } from '~core/product';
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
 * current rows and (for `drops`) per-product price extremes.
 *
 * @param kind - The report kind to run.
 * @param rows - The current rows the fake service returns.
 * @param extremes - Optional product id → window min/max price map.
 * @returns The report rows (page data) the service produced.
 */
async function run(
  kind: ReportKind,
  rows: ReportCurrentRow[],
  extremes?: Map<ID, { min: number; max: number }>,
): Promise<ReportRow[]> {
  const products = {
    findCurrentRows: jest.fn().mockResolvedValue(rows),
    latestDate: jest.fn().mockResolvedValue('2026-07-21'),
    priceExtremes: jest.fn().mockResolvedValue(extremes ?? new Map()),
  };

  const service = new ReportService(
    products as unknown as CoreProductService,
  );

  const page = await service.report(kind, FILTER, OPTIONS);

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
