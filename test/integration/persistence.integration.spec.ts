import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CorePriceSnapshotService } from '~core/price-snapshot';
import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import { CoreSyncLogService } from '~core/sync-log';
import { CoreTypeService } from '~core/type';
import { FactSource, ProductFactField, SyncTrigger } from '~enums';
import type {
  ID,
  ProductCanonicalInput,
  ProductFillInput,
  StoreProductUpsertInput,
} from '~types';

import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

/**
 * The report's per-user predicates are anti-joins against tables this suite
 * never writes, so any uuid reads as "a user with no preferences" — no `user`
 * row is needed.
 */
const USER_ID = '0198d1f6-0000-7000-8000-0000000000a1' as ID;

const SLUG = `__it_persist_${Date.now()}`;
const DAY = '2026-07-25';

describe('persistence write path (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let products: CoreProductService;
  let offers: CoreStoreProductService;
  let snapshots: CorePriceSnapshotService;
  let syncLogs: CoreSyncLogService;
  let types: CoreTypeService;
  let storeId: ID;
  let countryId: ID;

  const bottling = (
    over: Partial<ProductCanonicalInput> = {},
  ): ProductCanonicalInput => ({
    factSources: {},
    matchKey: `${SLUG}-key`,
    name: 'Sample 0.7l',
    brandId: null,
    typeId: null,
    countryId: null,
    age: null,
    abv: null,
    volumeMl: null,
    ...over,
  });

  /**
   * Creates a bottling and returns its id, so a test that only cares about the
   * offer side does not have to spell the catalogue out.
   */
  const makeBottling = async (
    over: Partial<ProductCanonicalInput> = {},
  ): Promise<ID> => {
    const { ids } = await products.findOrCreateByMatchKeys([bottling(over)]);

    return [...ids.values()][0];
  };

  const baseOffer = (
    productId: ID,
    over: Partial<StoreProductUpsertInput> = {},
  ): StoreProductUpsertInput => ({
    storeId,
    productId,
    sku: 'sku-1',
    url: 'https://example.test/p1',
    nameOrig: 'Віскі Sample 0.7л',
    seenOn: DAY,
    ...over,
  });

  const offerRow = async (sku: string): Promise<Record<string, unknown>> => {
    const rows = await dataSource.query(
      `SELECT sp."nameOrig", sp.url, sp."productId", sp."inStock",
              sp."firstSeen"::text AS "firstSeen",
              sp."lastSeen"::text AS "lastSeen",
              p.name, p.abv, p.age, p."volumeMl", p."brandId"
       FROM store_product sp
       JOIN product p ON p.id = sp."productId"
       WHERE sp."storeId" = $1 AND sp.sku = $2`,
      [storeId, sku],
    ) as Record<string, unknown>[];

    return rows[0];
  };

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    products = moduleRef.get(CoreProductService, { strict: false });
    offers = moduleRef.get(CoreStoreProductService, { strict: false });
    snapshots = moduleRef.get(CorePriceSnapshotService, { strict: false });
    syncLogs = moduleRef.get(CoreSyncLogService, { strict: false });
    types = moduleRef.get(CoreTypeService, { strict: false });

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

    const countryRows = await dataSource.query(
      `INSERT INTO country (code, "nameUa")
       VALUES ('it', 'IT Country')
       ON CONFLICT (code) DO UPDATE SET "nameUa" = EXCLUDED."nameUa"
       RETURNING id`,
    ) as { id: ID }[];

    countryId = countryRows[0].id;
  });

  afterEach(async () => {
    await dataSource.query('DELETE FROM store_product WHERE "storeId" = $1', [
      storeId,
    ]);
    /**
     * The offers go first: a bottling is protected by `RESTRICT` for as long
     * as any store lists it, which is the guard that keeps a stray delete from
     * taking a store's price history with it.
     */
    await dataSource.query(
      `DELETE FROM product
       WHERE "matchKey" LIKE $1
         AND NOT EXISTS (
           SELECT 1 FROM store_product sp WHERE sp."productId" = product.id
         )`,
      [`${SLUG}%`],
    );
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

  it('links a new SKU to the bottling it resolves to', async () => {
    const productId = await makeBottling({ abv: 40 });
    const offer = await offers.upsertFromScrape(baseOffer(productId));

    expect(offer?.isNew).toBe(true);
    expect(offer?.productId).toBe(productId);

    const row = await offerRow('sku-1');

    expect(row.abv).toBe(40);
    expect(row.firstSeen).toBe(DAY);
  });

  it('gives two stores one bottling and two price series', async () => {
    const other = await dataSource.query(
      `INSERT INTO store (slug, name, "baseUrl", active)
       VALUES ($1, 'IT Store 2', 'https://example2.test', true)
       RETURNING id`,
      [`${SLUG}_b`],
    ) as { id: ID }[];

    const productId = await makeBottling({ abv: 40 });

    const first = await offers.upsertFromScrape(baseOffer(productId));
    const second = await offers.upsertFromScrape({
      ...baseOffer(productId),
      storeId: other[0].id,
      sku: 'their-sku',
    });

    await snapshots.upsertForDate(first?.id as ID, DAY, {
      price: 1000,
      oldPrice: null,
      currency: 'UAH',
      inStock: true,
      promo: false,
    });
    await snapshots.upsertForDate(second?.id as ID, DAY, {
      price: 1200,
      oldPrice: null,
      currency: 'UAH',
      inStock: true,
      promo: false,
    });

    const rows = await dataSource.query(
      `SELECT sp.id, s.price::float8 AS price
       FROM store_product sp
       JOIN price_snapshot s ON s."storeProductId" = sp.id
       WHERE sp."productId" = $1
       ORDER BY s.price`,
      [productId],
    ) as { price: number }[];

    expect(rows.map((row) => row.price)).toEqual([1000, 1200]);

    await dataSource.query('DELETE FROM store_product WHERE "storeId" = $1', [
      other[0].id,
    ]);
    await dataSource.query('DELETE FROM store WHERE id = $1', [other[0].id]);
  });

  it('never re-links a stored SKU, whatever the listing now says', async () => {
    const first = await makeBottling();
    const second = await makeBottling({ matchKey: `${SLUG}-key-2` });

    await offers.upsertFromScrape(baseOffer(first));

    /**
     * A null `productId` is how a sync says "this SKU is already on file" —
     * the update clause leaves the link alone, which is what makes a manual
     * correction permanent.
     */
    const touched = await offers.upsertFromScrape({
      ...baseOffer(second, {
        nameOrig: 'Віскі Renamed 0.7л',
        url: 'https://example.test/p1-v2',
        seenOn: '2026-07-26',
      }),
      productId: null,
    });

    expect(touched?.productId).toBe(first);

    const row = await offerRow('sku-1');

    expect(row.productId).toBe(first);
    expect(row.nameOrig).toBe('Віскі Renamed 0.7л');
    expect(row.url).toBe('https://example.test/p1-v2');
    expect(row.firstSeen).toBe(DAY);
    expect(row.lastSeen).toBe('2026-07-26');
  });

  it('resolves an existing bottling instead of creating a second', async () => {
    const first = await products.findOrCreateByMatchKeys([bottling()]);
    const second = await products.findOrCreateByMatchKeys([
      bottling({ name: 'Different Name', abv: 43 }),
    ]);

    expect(first.added).toBe(1);
    expect(second.added).toBe(0);
    expect([...second.ids.values()]).toEqual([...first.ids.values()]);
  });

  it('resolves the same key once under concurrency', async () => {
    const [a, b] = await Promise.all([
      products.findOrCreateByMatchKeys([bottling()]),
      products.findOrCreateByMatchKeys([bottling()]),
    ]);

    expect([...a.ids.values()]).toEqual([...b.ids.values()]);

    const rows = await dataSource.query(
      'SELECT count(*)::int AS count FROM product WHERE "matchKey" = $1',
      [`${SLUG}-key`],
    ) as { count: number }[];

    expect(rows[0].count).toBe(1);
  });

  it('leaves every unmatchable bottling on its own', async () => {
    const first = await products.createUnmatched(bottling({ matchKey: null }));
    const second = await products.createUnmatched(bottling({ matchKey: null }));

    expect(first).not.toBe(second);

    await dataSource.query('DELETE FROM product WHERE id = ANY($1)', [
      [first, second],
    ]);
  });

  const fill = (
    productId: ID,
    over: Partial<ProductFillInput> = {},
  ): ProductFillInput => ({
    id: productId,
    abv: null,
    brandId: null,
    typeId: null,
    countryId: null,
    abvSource: FactSource.STORE,
    brandSource: FactSource.STORE,
    typeSource: FactSource.STORE,
    countrySource: FactSource.STORE,
    ...over,
  });

  const factRow = async (productId: ID): Promise<Record<string, unknown>> => {
    const rows = await dataSource.query(
      `SELECT abv, "typeId", "countryId", "abvSource", "typeSource",
              "countrySource"
       FROM product WHERE id = $1`,
      [productId],
    ) as Record<string, unknown>[];

    return rows[0];
  };

  it('fills a still-null field and holds against an equal source', async () => {
    const typeMap = await types.resolveByName(['single malt']);
    const typeId = typeMap.get('single malt') ?? null;
    const productId = await makeBottling({ abv: 40 });

    const filled = await products.fillMissing([
      fill(productId, { abv: 99, typeId, countryId }),
    ]);

    expect(filled).toBe(1);

    const row = await factRow(productId);

    /**
     * The stored 40 came from the same kind of source as the incoming 99, so
     * it stands: only a better-trusted source may overwrite, which is what
     * stops two stores from fighting over one bottling every night.
     */
    expect(row.abv).toBe(40);
    expect(row.typeId).toBe(typeId);
    expect(row.countryId).toBe(countryId);

    /**
     * Nothing left to fill means no write at all, so a shared row is not
     * locked by every store that lists it.
     */
    const again = await products.fillMissing([
      fill(productId, { abv: 99, typeId, countryId }),
    ]);

    expect(again).toBe(0);
  });

  it('lets a better-trusted source correct a stored value', async () => {
    const productId = await makeBottling({
      abv: 40,
      factSources: { [ProductFactField.ABV]: FactSource.LLM },
    });

    const before = await factRow(productId);
    expect(before.abvSource).toBe(FactSource.LLM);

    const filled = await products.fillMissing([
      fill(productId, { abv: 43, abvSource: FactSource.STORE }),
    ]);

    expect(filled).toBe(1);

    const after = await factRow(productId);

    /**
     * The whole point of provenance: a value the model guessed on the day the
     * bottling was discovered used to be permanent, because the write was
     * fill-if-null. A store that states the strength on its spec page now
     * corrects it.
     */
    expect(after.abv).toBe(43);
    expect(after.abvSource).toBe(FactSource.STORE);
  });

  it('never lets an automatic source overwrite a manual one', async () => {
    const productId = await makeBottling({ abv: 40 });

    await dataSource.query(
      'UPDATE product SET abv = 46, "abvSource" = $2 WHERE id = $1',
      [productId, FactSource.MANUAL],
    );

    const filled = await products.fillMissing([
      fill(productId, { abv: 43, abvSource: FactSource.STORE }),
    ]);

    expect(filled).toBe(0);

    const row = await factRow(productId);

    expect(row.abv).toBe(46);
    expect(row.abvSource).toBe(FactSource.MANUAL);
  });

  it('stamps provenance when the bottling is created', async () => {
    const productId = await makeBottling({
      abv: 40,
      factSources: { [ProductFactField.ABV]: FactSource.NAME },
    });

    const row = await factRow(productId);

    /**
     * A fact created without a source would rank below everything, so the very
     * next sync would overwrite the values the row was created from.
     */
    expect(row.abvSource).toBe(FactSource.NAME);
    expect(row.countrySource).toBeNull();
  });

  it('keeps one snapshot per offer per day under concurrency', async () => {
    const productId = await makeBottling();
    const offer = await offers.upsertFromScrape(baseOffer(productId));
    const id = offer?.id as ID;

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
       WHERE "storeProductId" = $1 AND "capturedOn" = $2`,
      [id, DAY],
    ) as { price: number }[];

    expect(rows).toHaveLength(1);
    expect([100, 200]).toContain(rows[0].price);
  });

  it('flags explicit out-of-stock offers by sku, not on empty', async () => {
    const productId = await makeBottling();

    await offers.upsertFromScrape(baseOffer(productId, { sku: 'keep' }));
    await offers.upsertFromScrape(baseOffer(productId, { sku: 'gone' }));

    expect(await offers.markOutOfStockBySkus(storeId, [])).toBe(0);
    expect(await offers.markOutOfStockBySkus(storeId, ['gone'])).toBe(1);

    const rows = await dataSource.query(
      `SELECT sku FROM store_product
       WHERE "storeId" = $1 AND "inStock" ORDER BY sku`,
      [storeId],
    ) as { sku: string }[];

    expect(rows.map((row) => row.sku)).toEqual(['keep']);
  });

  it('sweeps all not seen in stock; a re-upsert revives it', async () => {
    const productId = await makeBottling();

    await offers.upsertFromScrape(baseOffer(productId, { sku: 'seen' }));
    await offers.upsertFromScrape(baseOffer(productId, { sku: 'vanished' }));

    expect(await offers.markOutOfStockExcept(storeId, ['seen'])).toBe(1);

    const revived = await offers.upsertFromScrape(
      baseOffer(productId, { sku: 'vanished' }),
    );

    expect(revived?.isNew).toBe(false);

    const rows = await dataSource.query(
      `SELECT sku FROM store_product
       WHERE "storeId" = $1 AND "inStock" ORDER BY sku`,
      [storeId],
    ) as { sku: string }[];

    expect(rows.map((row) => row.sku)).toEqual(['seen', 'vanished']);
  });

  /**
   * A snapshot is written when an offer is *seen* in stock, but the sweep only
   * decides availability once the whole listing has been walked — and a capture
   * day can hold several runs. So the day's rows are reconciled with the
   * sweep's verdict; without it the day's first run owned them for good, since
   * an out-of-stock offer is never upserted again.
   */
  it("reconciles a day's snapshots with the offers' final state", async () => {
    const productId = await makeBottling();
    const seen = await offers.upsertFromScrape(
      baseOffer(productId, { sku: 'seen' }),
    );
    const vanished = await offers.upsertFromScrape(
      baseOffer(productId, { sku: 'vanished' }),
    );

    const price = {
      price: 100,
      oldPrice: null,
      currency: 'UAH',
      inStock: true,
      promo: false,
    };

    await snapshots.upsertForDate(seen?.id as ID, DAY, price);
    await snapshots.upsertForDate(vanished?.id as ID, DAY, price);

    await offers.markOutOfStockExcept(storeId, ['seen']);

    expect(await snapshots.markOutOfStockForDay(storeId, DAY)).toBe(1);

    const flags = await dataSource.query(
      `SELECT sp.sku, ps."inStock"
       FROM price_snapshot ps
       JOIN store_product sp ON sp.id = ps."storeProductId"
       WHERE sp."storeId" = $1 AND ps."capturedOn" = $2
       ORDER BY sp.sku`,
      [storeId, DAY],
    ) as { sku: string; inStock: boolean }[];

    expect(flags).toEqual([
      { sku: 'seen', inStock: true },
      { sku: 'vanished', inStock: false },
    ]);

    expect(await snapshots.markOutOfStockForDay(storeId, DAY)).toBe(0);

    /**
     * The other direction needs no statement of its own: a later run that
     * sees the offer again upserts the row back to in stock.
     */
    await offers.upsertFromScrape(baseOffer(productId, { sku: 'vanished' }));
    await snapshots.upsertForDate(vanished?.id as ID, DAY, price);

    const revived = await dataSource.query(
      `SELECT ps."inStock" FROM price_snapshot ps
       WHERE ps."storeProductId" = $1 AND ps."capturedOn" = $2`,
      [vanished?.id, DAY],
    ) as { inStock: boolean }[];

    expect(revived[0].inStock).toBe(true);
  });

  it('hides out-of-stock offers from lists, keeps detail', async () => {
    const productId = await makeBottling();
    const offer = await offers.upsertFromScrape(
      baseOffer(productId, { sku: 'oos' }),
    );
    const id = offer?.id as ID;

    await snapshots.upsertForDate(id, DAY, {
      price: 100,
      oldPrice: null,
      currency: 'UAH',
      inStock: true,
      promo: false,
    });

    await offers.markOutOfStockBySkus(storeId, ['oos']);

    expect(await offers.findCurrentRows({ userId: USER_ID, stores: [SLUG] }))
      .toHaveLength(0);

    const detail = await offers.findCurrentRowById(id);

    expect(detail?.inStock).toBe(false);
    expect(detail?.productId).toBe(productId);
  });

  it('finds a product by a term that survives only in nameOrig', async () => {
    // The descriptor carries the run-unique suffix: `resolveIdByTerm` searches
    // the whole catalogue, and a plain "Welsh" would match real rows when the
    // integration database is a restored production dump.
    const descriptor = `Welsh${SLUG}`;
    const productId = await makeBottling({ name: 'Aber Falls' });
    const offer = await offers.upsertFromScrape(baseOffer(productId, {
      sku: 'welsh',
      nameOrig: `Віскі Aber Falls ${descriptor} 40% 0,7л`,
    }));
    const id = offer?.id as ID;

    await snapshots.upsertForDate(id, DAY, {
      price: 100,
      oldPrice: null,
      currency: 'UAH',
      inStock: true,
      promo: false,
    });

    const byCleanName = await offers.findCurrentRows({
      userId: USER_ID,
      stores: [SLUG],
      name: 'Aber Falls',
    });

    expect(byCleanName.map((row) => row.id)).toContain(id);

    // The descriptor was stripped from the canonical name; both search paths
    // still find it because they match the offer's raw name too.
    const byDescriptor = await offers.findCurrentRows({
      userId: USER_ID,
      stores: [SLUG],
      name: descriptor,
    });

    expect(byDescriptor.map((row) => row.id)).toContain(id);
    expect(await offers.resolveIdByTerm(descriptor)).toBe(id);

    /**
     * A canonical id resolves to one of its offers, which is what lets the
     * edit endpoint and a future deep link take either id.
     */
    const ref = await offers.findOfferRefById(productId);

    expect(ref?.id).toBe(id);
    expect(ref?.productId).toBe(productId);
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
