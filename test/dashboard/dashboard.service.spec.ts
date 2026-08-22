import { DashboardBreakdownBy, DashboardGranularity } from '~enums';
import { BadRequestError } from '~errors';

import { DashboardService } from '../../src/domain/dashboard/dashboard.service';

import type {
  DashboardCaptureBounds,
  DashboardDailyRow,
  DashboardMover,
} from '~types';
import type { CorePriceSnapshotService } from '../../src/core/price-snapshot';
import type { CoreStoreProductService } from '../../src/core/store-product';
import type { CoreSyncLogService } from '../../src/core/sync-log';

/**
 * The production dump's capture bounds, used by most tests.
 */
const BOUNDS: DashboardCaptureBounds = {
  floor: '2026-06-12',
  latest: '2026-08-21',
  dayCount: 71,
};

/**
 * Builds a snapshot-side daily row from a few overrides.
 *
 * @param over - Fields to override.
 * @returns A complete daily row.
 */
function makeDaily(over: Partial<DashboardDailyRow> = {}): DashboardDailyRow {
  return {
    date: '2026-08-21',
    inStockListings: 100,
    distinctProducts: 80,
    distinctBrands: 30,
    activeStores: 5,
    p25Price: 800,
    medianPrice: 1500,
    p75Price: 3000,
    promoListings: 25,
    ...over,
  };
}

/**
 * Builds a mover row from a few overrides.
 *
 * @param over - Fields to override.
 * @returns A complete mover.
 */
function makeMover(over: Partial<DashboardMover> = {}): DashboardMover {
  return {
    storeProductId: 'offer-1',
    productId: 'product-1',
    name: 'Macallan 12',
    nameOrig: 'Macallan 12 yo',
    storeSlug: 'rozetka',
    storeName: 'Rozetka',
    firstDate: '2026-08-01',
    lastDate: '2026-08-21',
    firstPrice: 4000,
    lastPrice: 2000,
    changeAbs: -2000,
    changePct: -50,
    currency: 'UAH',
    ...over,
  };
}

interface Stubs {
  /**
   * The snapshot core-service stub.
   */
  snapshots: Record<string, jest.Mock>;

  /**
   * The store-product core-service stub.
   */
  offers: Record<string, jest.Mock>;

  /**
   * The sync-log core-service stub.
   */
  syncLogs: Record<string, jest.Mock>;

  /**
   * The service under test, built over the stubs.
   */
  service: DashboardService;
}

/**
 * Builds the service with fully stubbed core services.
 *
 * @returns The stubs and the service.
 */
function makeService(): Stubs {
  const snapshots = {
    captureBounds: jest.fn().mockResolvedValue(BOUNDS),
    coverage: jest.fn().mockResolvedValue([]),
    dailyMetrics: jest.fn().mockResolvedValue([]),
    dailyMetricsByStore: jest.fn().mockResolvedValue([]),
    dailyMetricsByCountry: jest.fn().mockResolvedValue([]),
    boundaryMetrics: jest.fn().mockResolvedValue([]),
    totalsForDate: jest.fn().mockResolvedValue({ listings: 0, products: 0 }),
    breakdownByType: jest.fn().mockResolvedValue([]),
    breakdownByCountry: jest.fn().mockResolvedValue([]),
    breakdownByStore: jest.fn().mockResolvedValue([]),
    breakdownByFlavor: jest.fn().mockResolvedValue([]),
    breakdownByPriceBucket: jest.fn().mockResolvedValue([]),
    priceEdges: jest.fn().mockResolvedValue([]),
  };

  const offers = {
    lifecycleByDay: jest.fn().mockResolvedValue([]),
    lifecycleByDayGrouped: jest.fn().mockResolvedValue([]),
  };

  const syncLogs = {
    activityByDay: jest.fn().mockResolvedValue([]),
  };

  const service = new DashboardService(
    snapshots as unknown as CorePriceSnapshotService,
    offers as unknown as CoreStoreProductService,
    syncLogs as unknown as CoreSyncLogService,
  );

  return { snapshots, offers, syncLogs, service };
}

describe('DashboardService range validation', () => {
  it('rejects an inverted range', async () => {
    const { service } = makeService();

    await expect(
      service.summary({ from: '2026-08-21', to: '2026-08-01' }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('rejects an oversized range', async () => {
    const { service } = makeService();

    await expect(
      service.summary({ from: '2020-01-01', to: '2026-08-21' }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('answers a range entirely before the data floor with nulls', async () => {
    const { service } = makeService();

    const summary = await service.summary({
      from: '2026-01-01',
      to: '2026-02-01',
    });

    expect(summary.baselineDate).toBeNull();
    expect(summary.inStockListings.latest).toBeNull();
    expect(summary.from).toBe('2026-01-01');
  });

  it('answers an empty database with nulls instead of throwing', async () => {
    const { service, snapshots } = makeService();

    snapshots.captureBounds?.mockResolvedValue({
      floor: null,
      latest: null,
      dayCount: 0,
    });

    const summary = await service.summary({
      from: '2026-08-01',
      to: '2026-08-21',
    });

    expect(summary.latestDate).toBeNull();
    expect(summary.medianPrice.latest).toBeNull();
  });
});

describe('DashboardService.summary', () => {
  it('builds every metric from the two boundary rows', async () => {
    const { service, snapshots, offers } = makeService();

    snapshots.boundaryMetrics?.mockResolvedValue([
      makeDaily({
        date: '2026-08-01',
        inStockListings: 90,
        promoListings: 9,
        medianPrice: 1000,
      }),
      makeDaily({
        date: '2026-08-21',
        inStockListings: 100,
        promoListings: 25,
        medianPrice: 1500,
      }),
    ]);
    offers.lifecycleByDay
      ?.mockResolvedValueOnce([{
        date: '2026-08-01',
        trackedListings: 95,
        newListings: 0,
        departedListings: 0,
      }])
      .mockResolvedValueOnce([{
        date: '2026-08-21',
        trackedListings: 120,
        newListings: 0,
        departedListings: 0,
      }]);

    const summary = await service.summary({
      from: '2026-08-01',
      to: '2026-08-21',
    });

    expect(summary.baselineDate).toBe('2026-08-01');
    expect(summary.latestDate).toBe('2026-08-21');
    expect(summary.inStockListings).toEqual({
      latest: 100,
      baseline: 90,
      delta: 10,
      deltaPct: expect.closeTo(11.11, 1) as number,
    });
    expect(summary.oosListings.latest).toBe(20);
    expect(summary.oosListings.baseline).toBe(5);
    expect(summary.promoShare.latest).toBeCloseTo(0.25);
    expect(summary.promoShare.baseline).toBeCloseTo(0.1);
    expect(summary.medianPrice.delta).toBe(500);
  });

  it('clamps the range to the snapshot bounds before querying', async () => {
    const { service, snapshots } = makeService();

    await service.summary({ from: '2026-01-01', to: '2026-12-31' });

    expect(snapshots.boundaryMetrics).toHaveBeenCalledWith(
      '2026-06-12',
      '2026-08-21',
      null,
    );
  });
});

describe('DashboardService.series', () => {
  it('honours an explicit day granularity over a long range', async () => {
    const { service } = makeService();

    const series = await service.series({
      from: '2026-06-12',
      to: '2026-08-21',
      granularity: DashboardGranularity.DAY,
    });

    expect(series.granularity).toBe(DashboardGranularity.DAY);
  });

  it('stays daily below the auto-week threshold', async () => {
    const { service } = makeService();

    const series = await service.series({
      from: '2026-08-01',
      to: '2026-08-21',
    });

    expect(series.granularity).toBe(DashboardGranularity.DAY);
  });

  it('escalates an unpinned long range to weeks and echoes it', async () => {
    const { service, snapshots } = makeService();

    snapshots.captureBounds?.mockResolvedValue({
      floor: '2025-01-01',
      latest: '2026-08-21',
      dayCount: 500,
    });

    const series = await service.series({
      from: '2026-01-01',
      to: '2026-08-21',
    });

    expect(series.granularity).toBe(DashboardGranularity.WEEK);
  });

  it('returns empty partitions unless they are requested', async () => {
    const { service, snapshots, offers } = makeService();

    const series = await service.series({
      from: '2026-08-01',
      to: '2026-08-21',
    });

    expect(series.byStore).toEqual([]);
    expect(series.byCountry).toEqual([]);
    expect(snapshots.dailyMetricsByStore).not.toHaveBeenCalled();
    expect(offers.lifecycleByDayGrouped).not.toHaveBeenCalled();
  });

  it('labels the store partition from the coverage', async () => {
    const { service, snapshots } = makeService();

    snapshots.dailyMetricsByStore?.mockResolvedValue([
      {
        ...makeDaily({ date: '2026-08-21', activeStores: 1 }),
        storeSlug: 'rozetka',
        storeName: 'Rozetka',
        storeColor: null,
      },
    ]);
    snapshots.coverage?.mockResolvedValue([{
      slug: 'rozetka',
      name: 'Rozetka',
      color: '#123456',
      active: true,
      firstDate: '2026-06-13',
      lastDate: '2026-08-21',
      listings: 1010,
      inStockListings: 881,
    }]);

    const series = await service.series({
      from: '2026-08-01',
      to: '2026-08-21',
      byStore: true,
    });

    expect(series.byStore).toHaveLength(1);
    expect(series.byStore[0]).toMatchObject({
      storeSlug: 'rozetka',
      name: 'Rozetka',
      color: '#123456',
    });
    expect(series.byStore[0]?.points[0]?.inStockListings).toBe(100);
  });

  it('labels the country partition from the snapshot rows', async () => {
    const { service, snapshots } = makeService();

    snapshots.dailyMetricsByCountry?.mockResolvedValue([
      {
        ...makeDaily({ date: '2026-08-21' }),
        countryCode: 'gb-sct',
        countryName: 'Шотландія',
        countryIcon: '🏴',
      },
    ]);

    const series = await service.series({
      from: '2026-08-01',
      to: '2026-08-21',
      byCountry: true,
    });

    expect(series.byCountry[0]).toMatchObject({
      countryCode: 'gb-sct',
      nameUa: 'Шотландія',
      icon: '🏴',
    });
  });
});

describe('DashboardService.breakdown', () => {
  it('defaults the date to the latest captured day and echoes it', async () => {
    const { service, snapshots } = makeService();

    const breakdown = await service.breakdown({
      by: DashboardBreakdownBy.TYPE,
    });

    expect(breakdown.date).toBe('2026-08-21');
    expect(snapshots.breakdownByType).toHaveBeenCalledWith(
      '2026-08-21',
      null,
    );
  });

  it('flags only the flavor dimension as overlapping', async () => {
    const { service } = makeService();

    const flavors = await service.breakdown({
      by: DashboardBreakdownBy.FLAVOR,
    });
    const types = await service.breakdown({ by: DashboardBreakdownBy.TYPE });

    expect(flavors.overlapping).toBe(true);
    expect(types.overlapping).toBe(false);
  });

  it('maps price-bucket ordinals to their bounds', async () => {
    const { service, snapshots } = makeService();

    snapshots.breakdownByPriceBucket?.mockResolvedValue([
      { key: '0', listings: 787, products: 300, medianPrice: 350 },
      { key: '3', listings: 1186, products: 900, medianPrice: 2400 },
      { key: '6', listings: 496, products: 400, medianPrice: 15000 },
    ]);

    const breakdown = await service.breakdown({
      by: DashboardBreakdownBy.PRICE_BUCKET,
    });

    expect(breakdown.buckets[0]).toMatchObject({
      minPrice: null,
      maxPrice: 500,
    });
    expect(breakdown.buckets[1]).toMatchObject({
      minPrice: 2000,
      maxPrice: 3000,
    });
    expect(breakdown.buckets[2]).toMatchObject({
      minPrice: 10000,
      maxPrice: null,
    });
  });
});

describe('DashboardService.movers', () => {
  it('keeps only genuine drops and rises per direction', async () => {
    const { service, snapshots } = makeService();

    snapshots.priceEdges
      ?.mockResolvedValueOnce([
        makeMover({ changePct: -50 }),
        makeMover({ changePct: 10 }),
      ])
      .mockResolvedValueOnce([
        makeMover({ changePct: 18 }),
        makeMover({ changePct: -5 }),
      ]);

    const movers = await service.movers({
      from: '2026-08-01',
      to: '2026-08-21',
    });

    expect(movers.drops).toHaveLength(1);
    expect(movers.drops[0]?.changePct).toBe(-50);
    expect(movers.rises).toHaveLength(1);
    expect(movers.rises[0]?.changePct).toBe(18);
  });

  it('applies the default limit', async () => {
    const { service, snapshots } = makeService();

    await service.movers({ from: '2026-08-01', to: '2026-08-21' });

    expect(snapshots.priceEdges).toHaveBeenCalledWith(
      '2026-08-01',
      '2026-08-21',
      null,
      10,
      null,
      'asc',
    );
  });
});

describe('DashboardService.syncActivity', () => {
  it('passes the raw range through without snapshot clamping', async () => {
    const { service, syncLogs } = makeService();

    await service.syncActivity({
      from: '2026-05-01',
      to: '2026-08-22',
      stores: ['rozetka'],
    });

    expect(syncLogs.activityByDay).toHaveBeenCalledWith(
      '2026-05-01',
      '2026-08-22',
      ['rozetka'],
    );
  });
});
