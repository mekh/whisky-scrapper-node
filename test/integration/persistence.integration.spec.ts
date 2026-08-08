import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CoreBrandService } from '~core/brand';
import { CorePriceSnapshotService } from '~core/price-snapshot';
import { CoreProductService } from '~core/product';
import { CoreSyncLogService } from '~core/sync-log';
import { SyncTrigger } from '~enums';
import type { ID, ProductUpsertInput } from '~types';

import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

const SLUG = `__it_persist_${Date.now()}`;
const DAY = '2026-07-25';

describe('persistence write path (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let products: CoreProductService;
  let snapshots: CorePriceSnapshotService;
  let syncLogs: CoreSyncLogService;
  let brands: CoreBrandService;
  let storeId: ID;

  const baseProduct = (
    over: Partial<ProductUpsertInput>,
  ): ProductUpsertInput => ({
    storeId,
    sku: 'sku-1',
    url: 'https://example.test/p1',
    nameOrig: 'Віскі Sample 0.7л',
    name: 'Sample 0.7l',
    brandId: null,
    typeId: null,
    countryId: null,
    age: null,
    abv: null,
    volumeMl: null,
    seenOn: DAY,
    ...over,
  });

  const productRow = async (sku: string): Promise<Record<string, unknown>> => {
    const rows = await dataSource.query(
      `SELECT name, "nameOrig", url, abv, age, "volumeMl", "brandId",
              "firstSeen"::text AS "firstSeen", "lastSeen"::text AS "lastSeen"
       FROM product WHERE "storeId" = $1 AND sku = $2`,
      [storeId, sku],
    ) as Record<string, unknown>[];

    return rows[0];
  };

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    products = moduleRef.get(CoreProductService, { strict: false });
    snapshots = moduleRef.get(CorePriceSnapshotService, { strict: false });
    syncLogs = moduleRef.get(CoreSyncLogService, { strict: false });
    brands = moduleRef.get(CoreBrandService, { strict: false });

    const rows = await dataSource.query(
      `INSERT INTO store (slug, name, "baseUrl", active)
       VALUES ($1, 'IT Store', 'https://example.test', true)
       RETURNING id`,
      [SLUG],
    ) as { id: ID }[];

    storeId = rows[0].id;

    await dataSource.query(
      `INSERT INTO store_config
         ("storeId", tier, "delayFrom", "delayTo", "needsBrowser", engine)
       VALUES ($1, 1, 0, 0, false, 'ts')`,
      [storeId],
    );
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM product WHERE "storeId" = $1', [
      storeId,
    ]);
    await dataSource.query('DELETE FROM sync_log WHERE "storeId" = $1', [
      storeId,
    ]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM store WHERE id = $1', [storeId]);

      await closeIntegrationModule(moduleRef);
    }
  });

  it('upserts a product and reports it as new on first insert', async () => {
    const result = await products.upsertFromScrape(baseProduct({ abv: 40 }));

    expect(result.isNew).toBe(true);

    const row = await productRow('sku-1');

    expect(row.abv).toBe(40);
    expect(row.firstSeen).toBe(DAY);
  });

  it('preserves first-insert fields, merges brand on re-upsert', async () => {
    const brandMap = await brands.resolveByName(['Sample Distillery']);
    const brandId = brandMap.get('Sample Distillery') ?? null;

    const first = await products.upsertFromScrape(
      baseProduct({ abv: 40, age: 12, volumeMl: 700, brandId }),
    );

    const second = await products.upsertFromScrape(
      baseProduct({
        name: 'Renamed Later',
        nameOrig: 'Віскі Renamed 0.7л',
        url: 'https://example.test/p1-v2',
        abv: 99,
        age: 1,
        volumeMl: 50,
        brandId: null,
        seenOn: '2026-07-26',
      }),
    );

    expect(first.id).toBe(second.id);
    expect(second.isNew).toBe(false);

    const row = await productRow('sku-1');

    // First-insert / manually-editable fields survive the second scrape.
    expect(row.name).toBe('Sample 0.7l');
    expect(row.abv).toBe(40);
    expect(row.age).toBe(12);
    expect(row.volumeMl).toBe(700);
    expect(row.firstSeen).toBe(DAY);
    // brandId is COALESCEd: a later null never clears a known brand.
    expect(row.brandId).toBe(brandId);
    // These always refresh.
    expect(row.nameOrig).toBe('Віскі Renamed 0.7л');
    expect(row.url).toBe('https://example.test/p1-v2');
    expect(row.lastSeen).toBe('2026-07-26');
  });

  it('keeps one snapshot per product per day under concurrency', async () => {
    const { id } = await products.upsertFromScrape(baseProduct({}));

    await Promise.all([
      snapshots.upsertForDate(id, DAY, {
        price: 100,
        oldPrice: null,
        currency: 'UAH',
        inStock: true,
        promo: false,
      }),
      snapshots.upsertForDate(id, DAY, {
        price: 200,
        oldPrice: 150,
        currency: 'UAH',
        inStock: true,
        promo: true,
      }),
    ]);

    const rows = await dataSource.query(
      `SELECT price::float8 AS price FROM price_snapshot
       WHERE "productId" = $1 AND "capturedOn" = $2`,
      [id, DAY],
    ) as { price: number }[];

    expect(rows).toHaveLength(1);
    expect([100, 200]).toContain(rows[0].price);
  });

  it('flags explicit out-of-stock products by sku, not on empty', async () => {
    await products.upsertFromScrape(baseProduct({ sku: 'keep' }));
    await products.upsertFromScrape(baseProduct({ sku: 'gone' }));

    const flaggedOnEmpty = await products.markOutOfStockBySkus(storeId, []);

    expect(flaggedOnEmpty).toBe(0);

    const flagged = await products.markOutOfStockBySkus(storeId, ['gone']);

    expect(flagged).toBe(1);

    const rows = await dataSource.query(
      `SELECT sku FROM product
       WHERE "storeId" = $1 AND "inStock" ORDER BY sku`,
      [storeId],
    ) as { sku: string }[];

    expect(rows.map((row) => row.sku)).toEqual(['keep']);
  });

  it('sweeps all not seen in stock; a re-upsert revives it', async () => {
    await products.upsertFromScrape(baseProduct({ sku: 'seen' }));
    await products.upsertFromScrape(baseProduct({ sku: 'vanished' }));

    const swept = await products.markOutOfStockExcept(storeId, ['seen']);

    expect(swept).toBe(1);

    const revived = await products.upsertFromScrape(
      baseProduct({ sku: 'vanished' }),
    );

    expect(revived.isNew).toBe(false);

    const rows = await dataSource.query(
      `SELECT sku FROM product
       WHERE "storeId" = $1 AND "inStock" ORDER BY sku`,
      [storeId],
    ) as { sku: string }[];

    expect(rows.map((row) => row.sku)).toEqual(['seen', 'vanished']);
  });

  it('hides out-of-stock products from lists, keeps detail', async () => {
    const { id } = await products.upsertFromScrape(baseProduct({ sku: 'oos' }));

    await snapshots.upsertForDate(id, DAY, {
      price: 100,
      oldPrice: null,
      currency: 'UAH',
      inStock: true,
      promo: false,
    });

    await products.markOutOfStockBySkus(storeId, ['oos']);

    const listed = await products.findCurrentRows({ stores: [SLUG] });

    expect(listed).toHaveLength(0);

    const detail = await products.findCurrentRowById(id);

    expect(detail?.inStock).toBe(false);
  });

  it('lets only one concurrent run start in the same group', async () => {
    const [a, b] = await Promise.all([
      syncLogs.tryStart(storeId, 'it-group', SyncTrigger.MANUAL),
      syncLogs.tryStart(storeId, 'it-group', SyncTrigger.MANUAL),
    ]);

    const started = [a, b].filter((row) => row !== null);

    expect(started).toHaveLength(1);
  });

  it('frees the lock after a run finishes or is swept', async () => {
    const first = await syncLogs.tryStart(storeId, null, SyncTrigger.MANUAL);

    expect(first).not.toBeNull();

    const blocked = await syncLogs.tryStart(storeId, null, SyncTrigger.MANUAL);

    expect(blocked).toBeNull();

    const swept = await syncLogs.sweepOrphaned();

    expect(swept).toBeGreaterThanOrEqual(1);

    const afterSweep = await syncLogs.tryStart(
      storeId,
      null,
      SyncTrigger.MANUAL,
    );

    expect(afterSweep).not.toBeNull();
  });
});
