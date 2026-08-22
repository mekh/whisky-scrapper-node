import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CorePreferenceService } from '~core/preference';
import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import type { ID } from '~types';

import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

const STAMP = Date.now();

const SLUG = `__it_ps_${STAMP}`;

const TOKEN = `itps${STAMP}`;

const DAY = '2026-07-25';

/**
 * The autocomplete search (`ProductRepository.searchByName`) against the live
 * database. What matters here and cannot be unit-tested: the term matches the
 * canonical name OR any store's raw name, the age-aware pass reaches an aged
 * bottling whose canonical name lacks the number, in-stock rows rank first,
 * the limit holds — and a blacklisted bottling still appears, which is the
 * contract's deliberate surprise (the picker must be able to find an entry so
 * it can be un-hidden), pinned here so nobody "fixes" it.
 */
describe('product autocomplete search (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let products: CoreProductService;
  let offers: CoreStoreProductService;
  let preferences: CorePreferenceService;
  let storeId: ID;
  let userId: ID;
  let namedId: ID;
  let rawOnlyId: ID;
  let agedId: ID;
  let oosId: ID;

  /**
   * Creates a bottling with no match key, so nothing else can match it.
   *
   * @param name - Canonical name, or null for a nameless bottling.
   * @param age - Age statement, when the test needs one.
   * @returns The new canonical product id.
   */
  const makeBottling = async (
    name: string | null,
    age: number | null = null,
  ): Promise<ID> => {
    return products.createUnmatched({
      matchKey: null,
      name,
      brandId: null,
      typeId: null,
      countryId: null,
      age,
      abv: null,
      volumeMl: 700,
    });
  };

  /**
   * Creates one store offer for a bottling.
   *
   * @param productId - The bottling offered.
   * @param sku - The store's SKU for it.
   * @param nameOrig - The offer's raw name.
   * @param inStock - Whether the offer is currently in stock.
   * @returns Resolves once the offer exists.
   */
  const makeOffer = async (
    productId: ID,
    sku: string,
    nameOrig: string,
    inStock = true,
  ): Promise<void> => {
    const offer = await offers.upsertFromScrape({
      storeId,
      productId,
      sku,
      url: `https://example.test/${sku}`,
      nameOrig,
      seenOn: DAY,
    });

    if (!offer) {
      throw new Error('Offer upsert returned nothing');
    }

    if (!inStock) {
      await dataSource.query(
        'UPDATE store_product SET "inStock" = false WHERE id = $1',
        [offer.id],
      );
    }
  };

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    products = moduleRef.get(CoreProductService, { strict: false });
    offers = moduleRef.get(CoreStoreProductService, { strict: false });
    preferences = moduleRef.get(CorePreferenceService, { strict: false });

    const stores = await dataSource.query(
      `INSERT INTO store (slug, name, "baseUrl", active)
       VALUES ($1, 'IT Search', 'https://example.test', true)
       RETURNING id`,
      [SLUG],
    ) as { id: ID }[];

    storeId = stores[0].id;

    const users = await dataSource.query(
      `INSERT INTO "user" (name, password, active)
       VALUES ($1, 'x', false)
       RETURNING id`,
      [`itps${STAMP}u`.slice(0, 32)],
    ) as { id: ID }[];

    userId = users[0].id;

    namedId = await makeBottling(`${TOKEN} Named`);
    rawOnlyId = await makeBottling(`${TOKEN}hidden Canonical`);
    agedId = await makeBottling(`${TOKEN}aged`, 12);
    oosId = await makeBottling(`${TOKEN} Named Sold Out`);

    await makeOffer(namedId, 'sku-named', `Віскі ${TOKEN} Named 0,7л`);
    await makeOffer(rawOnlyId, 'sku-raw', `Віскі ${TOKEN}raw Special 0,7л`);
    await makeOffer(agedId, 'sku-aged', `Віскі ${TOKEN}aged 12 років`);
    await makeOffer(oosId, 'sku-oos', `Віскі ${TOKEN} Sold 0,7л`, false);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(
        'DELETE FROM store_product WHERE "storeId" = $1',
        [storeId],
      );
      await dataSource.query(
        'DELETE FROM product WHERE id = ANY($1::uuid[])',
        [[namedId, rawOnlyId, agedId, oosId]],
      );
      await dataSource.query('DELETE FROM store WHERE id = $1', [storeId]);
      await dataSource.query('DELETE FROM "user" WHERE id = $1', [userId]);

      await closeIntegrationModule(moduleRef);
    }
  });

  it('matches on the canonical name', async () => {
    const rows = await products.search(`${TOKEN} Named`, 10);

    expect(rows.map((row) => row.productId)).toContain(namedId);
  });

  it("matches on a store's raw name alone", async () => {
    const rows = await products.search(`${TOKEN}raw`, 10);

    expect(rows.map((row) => row.productId)).toEqual([rawOnlyId]);
  });

  it('reaches an aged bottling through the trailing-age pass', async () => {
    /**
     * The canonical name holds no `12` (nor does the plain substring match),
     * so only the `splitAge` OR-pass can answer this — the same reason the
     * report search splits the term.
     */
    const rows = await products.search(`${TOKEN}aged 12`, 10);

    expect(rows.map((row) => row.productId)).toContain(agedId);
  });

  it('ranks in-stock bottlings above sold-out ones', async () => {
    const rows = await products.search(`${TOKEN} Named`, 10);

    expect(rows.map((row) => row.productId)).toEqual([namedId, oosId]);
    expect(rows[0].inStock).toBe(true);
    expect(rows[1].inStock).toBe(false);
  });

  it('honours the limit', async () => {
    const rows = await products.search(TOKEN, 2);

    expect(rows).toHaveLength(2);
  });

  it('still finds a bottling somebody blacklisted', async () => {
    await preferences.addToBlacklist(userId, {
      productIds: [namedId],
      brandIds: [],
    });

    const rows = await products.search(`${TOKEN} Named`, 10);

    expect(rows.map((row) => row.productId)).toContain(namedId);

    await dataSource.query(
      'DELETE FROM blacklist_product WHERE "userId" = $1',
      [userId],
    );
  });
});
