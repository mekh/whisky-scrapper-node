import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CorePriceSnapshotService } from '~core/price-snapshot';
import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import { CoreSyncLogService } from '~core/sync-log';
import { DashboardBreakdownBy } from '~enums';
import type { DashboardSeries, ID } from '~types';

import { DashboardService } from '../../src/domain/dashboard/dashboard.service';
import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

const STAMP = Date.now();

const SLUG_A = `__it_dash_a_${STAMP}`;

const SLUG_B = `__it_dash_b_${STAMP}`;

/**
 * A match-key token no catalogue row can contain, so cleanup deletes exactly
 * the seeded bottlings.
 */
const TOKEN = `itdash${STAMP}`;

/**
 * Five consecutive days inside the production dump's snapshot range, so the
 * seeding never moves the global capture bounds the service clamps against.
 * Every dashboard call below scopes itself to the two seeded stores, which is
 * what keeps the assertions independent of the surrounding real data.
 */
const D1 = '2026-07-01';

const D2 = '2026-07-02';

const D3 = '2026-07-03';

const D4 = '2026-07-04';

const D5 = '2026-07-05';

describe('dashboard aggregates over the live queries (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let products: CoreProductService;
  let offers: CoreStoreProductService;
  let snapshots: CorePriceSnapshotService;
  let syncLogs: CoreSyncLogService;
  let service: DashboardService;
  let storeA: ID;
  let storeB: ID;
  let scope: string[];

  /**
   * Creates a store with a config row.
   *
   * @param slug - The store slug.
   * @param name - The store display name.
   * @returns The new store id.
   */
  const makeStore = async (slug: string, name: string): Promise<ID> => {
    const rows = await dataSource.query(
      `INSERT INTO store (slug, name, "baseUrl", active)
       VALUES ($1, $2, 'https://example.test', true)
       RETURNING id`,
      [slug, name],
    ) as { id: ID }[];

    await dataSource.query(
      `INSERT INTO store_config
         ("storeId", tier, "delayFrom", "delayTo", "needsBrowser", engine)
       VALUES ($1, 1, 0, 0, false, 'ts')`,
      [rows[0].id],
    );

    return rows[0].id;
  };

  /**
   * Creates a bottling.
   *
   * @param key - Suffix of its match key.
   * @returns The new product id.
   */
  const makeBottling = async (key: string): Promise<ID> => {
    const { ids } = await products.findOrCreateByMatchKeys([
      {
        matchKey: `${TOKEN}-${key}`,
        name: `Dash ${TOKEN} ${key}`,
        brandId: null,
        typeId: null,
        countryId: null,
        age: null,
        abv: null,
        volumeMl: 700,
      },
    ]);

    return [...ids.values()][0];
  };

  /**
   * Creates one store's offer with snapshots on the given days.
   *
   * @param storeId - The store carrying it.
   * @param productId - The bottling offered.
   * @param sku - The offer SKU.
   * @param firstSeen - The offer's first-seen day.
   * @param prices - Price per snapshot day.
   * @returns The offer id.
   */
  const makeOffer = async (
    storeId: ID,
    productId: ID,
    sku: string,
    firstSeen: string,
    prices: Record<string, number>,
  ): Promise<ID> => {
    const offer = await offers.upsertFromScrape({
      storeId,
      productId,
      sku,
      url: `https://example.test/${sku}`,
      nameOrig: `Віскі ${TOKEN} ${sku}`,
      seenOn: firstSeen,
    });

    if (!offer) {
      throw new Error('Offer upsert returned nothing');
    }

    const days = Object.keys(prices).sort();

    for (const day of days) {
      await snapshots.upsertForDate(offer.id, day, {
        price: prices[day],
        oldPrice: null,
        currency: 'UAH',
        inStock: true,
        promo: false,
      });
    }

    return offer.id;
  };

  /**
   * Finds one date's point in a series.
   *
   * @param points - The series points.
   * @param date - The date to find.
   * @returns The matching point.
   */
  const pointAt = (
    points: DashboardSeries['total'],
    date: string,
  ): DashboardSeries['total'][number] => {
    const point = points.find((entry) => entry.date === date);

    if (!point) {
      throw new Error(`No point for ${date}`);
    }

    return point;
  };

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    products = moduleRef.get(CoreProductService, { strict: false });
    offers = moduleRef.get(CoreStoreProductService, { strict: false });
    snapshots = moduleRef.get(CorePriceSnapshotService, { strict: false });
    syncLogs = moduleRef.get(CoreSyncLogService, { strict: false });

    service = new DashboardService(snapshots, offers, syncLogs);

    storeA = await makeStore(SLUG_A, 'IT Dash A');
    storeB = await makeStore(SLUG_B, 'IT Dash B');
    scope = [SLUG_A, SLUG_B];

    const prodA = await makeBottling('a');
    const prodB = await makeBottling('b');
    const prodC = await makeBottling('c');
    const prodD = await makeBottling('d');

    /**
     * The continuous baseline: in stock every day at a flat price.
     */
    await makeOffer(storeA, prodA, 'sku-a', D1, {
      [D1]: 1000,
      [D2]: 1000,
      [D3]: 1000,
      [D4]: 1000,
      [D5]: 1000,
    });

    /**
     * The mid-life gap: no snapshot on D3, so that day must count it as
     * derived out-of-stock.
     */
    await makeOffer(storeA, prodB, 'sku-b', D1, {
      [D1]: 2000,
      [D2]: 2000,
      [D4]: 2000,
      [D5]: 2000,
    });

    /**
     * The late arrival: first seen mid-range.
     */
    await makeOffer(storeA, prodC, 'sku-c', D3, {
      [D3]: 3000,
      [D4]: 3000,
      [D5]: 3000,
    });

    /**
     * The departure: last seen on D3, flagged out of stock — it must count
     * as out-of-stock on D4 and D5 (Definition A) and as a big price drop.
     */
    const offerD = await makeOffer(storeA, prodD, 'sku-d', D1, {
      [D1]: 1000,
      [D2]: 700,
      [D3]: 400,
    });

    await dataSource.query(
      `UPDATE store_product
       SET "inStock" = false, "lastSeen" = $2
       WHERE id = $1`,
      [offerD, D3],
    );

    /**
     * The second store carries the same bottling as `sku-a` — which is what
     * makes per-store distinct-product sums exceed the total — at a rising
     * price.
     */
    await makeOffer(storeB, prodA, 'sku-e', D1, {
      [D1]: 1000,
      [D2]: 1100,
      [D3]: 1100,
      [D4]: 1100,
      [D5]: 1180,
    });

    /**
     * A finished run late on the range's last day, for the half-open
     * timestamp-bound assertion.
     */
    await dataSource.query(
      `INSERT INTO sync_log
         ("storeId", added, removed, updated, total, success,
          "createdAt", "updatedAt", "finishedAt")
       VALUES ($1, 4, 1, 10, 20, true,
               $2::timestamp, $2::timestamp,
               $2::timestamp + interval '5 minutes')`,
      [storeA, `${D5} 23:50:00`],
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(
        'DELETE FROM store_product WHERE "storeId" = ANY($1)',
        [[storeA, storeB]],
      );
      await dataSource.query('DELETE FROM product WHERE "matchKey" LIKE $1', [
        `${TOKEN}%`,
      ]);
      await dataSource.query('DELETE FROM store WHERE id = ANY($1)', [
        [storeA, storeB],
      ]);

      await closeIntegrationModule(moduleRef);
    }
  });

  it('reproduces the lifecycle edge cases in the total series', async () => {
    const series = await service.series({ from: D1, to: D5, stores: scope });

    expect(series.total).toHaveLength(5);

    expect(pointAt(series.total, D1)).toMatchObject({
      inStockListings: 4,
      trackedListings: 4,
      oosListings: 0,
      newListings: 4,
      distinctProducts: 3,
      medianPrice: 1000,
    });

    /**
     * D3: the gap listing has no snapshot (derived OOS), the late arrival
     * appears (tracked steps up to 5, one new listing).
     */
    expect(pointAt(series.total, D3)).toMatchObject({
      inStockListings: 4,
      trackedListings: 5,
      oosListings: 1,
      newListings: 1,
    });

    /**
     * D4/D5: the departed listing keeps counting as out of stock — the
     * Definition-A behaviour, not the `lastSeen >= day` variant that would
     * drop it from the denominator.
     */
    expect(pointAt(series.total, D4)).toMatchObject({
      inStockListings: 4,
      trackedListings: 5,
      oosListings: 1,
    });
    expect(pointAt(series.total, D5)).toMatchObject({
      inStockListings: 4,
      oosListings: 1,
      distinctProducts: 3,
      medianPrice: 1590,
    });

    /**
     * The departure is knowable only from the next day's absence, and it is
     * attributed to the listing's own last-seen day.
     */
    expect(pointAt(series.total, D3).departedListings).toBe(1);
    expect(pointAt(series.total, D4).departedListings).toBe(0);
  });

  it('returns numbers, not driver strings, from the aggregates', async () => {
    const series = await service.series({ from: D1, to: D5, stores: scope });
    const point = pointAt(series.total, D5);

    expect(typeof point.inStockListings).toBe('number');
    expect(typeof point.medianPrice).toBe('number');
  });

  it('partitions per store without letting distincts sum to the total', async () => {
    const series = await service.series({
      from: D1,
      to: D5,
      stores: scope,
      byStore: true,
    });

    const a = series.byStore.find((entry) => entry.storeSlug === SLUG_A);
    const b = series.byStore.find((entry) => entry.storeSlug === SLUG_B);
    const total = pointAt(series.total, D5);
    const aD5 = pointAt(a?.points ?? [], D5);
    const bD5 = pointAt(b?.points ?? [], D5);

    expect(a?.name).toBe('IT Dash A');
    expect(aD5.inStockListings + bD5.inStockListings).toBe(
      total.inStockListings,
    );

    /**
     * The shared bottling counts once in the total but once per store in the
     * partitions — the inequality that makes a rollup table unable to serve
     * cross-store distinct counts.
     */
    expect(aD5.distinctProducts + bD5.distinctProducts).toBeGreaterThan(
      total.distinctProducts,
    );
  });

  it('summarizes the boundary days with the derived OOS pair', async () => {
    const summary = await service.summary({
      from: D1,
      to: D5,
      stores: scope,
    });

    expect(summary.baselineDate).toBe(D1);
    expect(summary.latestDate).toBe(D5);
    expect(summary.inStockListings.latest).toBe(4);
    expect(summary.trackedListings).toMatchObject({
      latest: 5,
      baseline: 4,
      delta: 1,
    });
    expect(summary.oosListings.latest).toBe(1);
    expect(summary.oosListings.baseline).toBe(0);
    expect(summary.medianPrice.latest).toBe(1590);
    expect(summary.activeStores.latest).toBe(2);
  });

  it('slices the price buckets with open-ended bounds', async () => {
    const breakdown = await service.breakdown({
      by: DashboardBreakdownBy.PRICE_BUCKET,
      date: D5,
      stores: scope,
    });

    expect(breakdown.date).toBe(D5);
    expect(breakdown.totalListings).toBe(4);
    expect(breakdown.totalProducts).toBe(3);
    expect(breakdown.buckets).toEqual([
      expect.objectContaining({
        key: '2',
        listings: 2,
        minPrice: 1000,
        maxPrice: 2000,
      }),
      expect.objectContaining({
        key: '3',
        listings: 1,
        minPrice: 2000,
        maxPrice: 3000,
      }),
      expect.objectContaining({
        key: '4',
        listings: 1,
        minPrice: 3000,
        maxPrice: 5000,
      }),
    ]);
  });

  it('ranks the movers over each listing\'s own edge days', async () => {
    const movers = await service.movers({ from: D1, to: D5, stores: scope });

    expect(movers.drops[0]).toMatchObject({
      storeSlug: SLUG_A,
      firstDate: D1,
      lastDate: D3,
      firstPrice: 1000,
      lastPrice: 400,
      changePct: -60,
    });
    expect(movers.drops[0]?.productId).toBeTruthy();

    expect(movers.rises[0]).toMatchObject({
      storeSlug: SLUG_B,
      firstPrice: 1000,
      lastPrice: 1180,
      changePct: 18,
    });

    /**
     * Flat-priced listings are not movers, so exactly one drop and one rise
     * exist within the seeded scope.
     */
    expect(movers.drops).toHaveLength(1);
    expect(movers.rises).toHaveLength(1);
  });

  it('includes runs after midnight of the range end (half-open bound)', async () => {
    const activity = await service.syncActivity({
      from: D1,
      to: D5,
      stores: scope,
    });

    const day = activity.days.find((entry) => entry.date === D5);

    expect(day).toMatchObject({
      runs: 1,
      succeeded: 1,
      added: 4,
      removed: 1,
      updated: 10,
      itemsSeen: 20,
    });
    expect(day?.avgDurationMs).toBe(300_000);
  });
});
