import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CoreBrandService } from '~core/brand';
import { CorePreferenceService } from '~core/preference';
import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import type { ID } from '~types';

import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

const STAMP = Date.now();

const SLUG = `__it_pd_${STAMP}`;

const TOKEN = `itpd${STAMP}`;

const BRAND = `__it_pd_brand_${STAMP}`;

const DAY = '2026-07-25';

const ADDED_ON = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The resolved preference read (`findDetailsByUserId`) against the live
 * database. What matters here and cannot be unit-tested: the raw SQL resolves
 * names through the representative-offer lateral (with its fallbacks for a
 * bottling no store lists), partitions favorite and blacklist rows of the
 * same user correctly, orders newest first, and never leaks another user's
 * rows.
 */
describe('preference details over the live query (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let preferences: CorePreferenceService;
  let products: CoreProductService;
  let offers: CoreStoreProductService;
  let brands: CoreBrandService;
  let storeId: ID;
  let userA: ID;
  let userB: ID;
  let brandId: ID;
  let namedId: ID;
  let namelessId: ID;
  let orphanId: ID;

  /**
   * Creates a throwaway user.
   *
   * @param suffix - Distinguishes the row from the suite's other user.
   * @returns The new user id.
   */
  const makeUser = async (suffix: string): Promise<ID> => {
    const rows = await dataSource.query(
      `INSERT INTO "user" (name, password, active)
       VALUES ($1, 'x', false)
       RETURNING id`,
      [`itpd${STAMP}${suffix}`.slice(0, 32)],
    ) as { id: ID }[];

    return rows[0].id;
  };

  /**
   * Creates a bottling with no match key, so nothing else can match it.
   *
   * @param name - Canonical name, or null for a nameless bottling.
   * @param brand - Brand to attach, when the test needs one.
   * @returns The new canonical product id.
   */
  const makeBottling = async (
    name: string | null,
    brand?: ID,
  ): Promise<ID> => {
    return products.createUnmatched({
      factSources: {},
      matchKey: null,
      name,
      brandId: brand ?? null,
      typeId: null,
      countryId: null,
      age: 12,
      abv: 43.5,
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
   * @returns The new offer id.
   */
  const makeOffer = async (
    productId: ID,
    sku: string,
    nameOrig: string,
    inStock = true,
  ): Promise<ID> => {
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

    return offer.id;
  };

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    preferences = moduleRef.get(CorePreferenceService, { strict: false });
    products = moduleRef.get(CoreProductService, { strict: false });
    offers = moduleRef.get(CoreStoreProductService, { strict: false });
    brands = moduleRef.get(CoreBrandService, { strict: false });

    const stores = await dataSource.query(
      `INSERT INTO store (slug, name, "baseUrl", active)
       VALUES ($1, 'IT Details', 'https://example.test', true)
       RETURNING id`,
      [SLUG],
    ) as { id: ID }[];

    storeId = stores[0].id;
    userA = await makeUser('a');
    userB = await makeUser('b');

    const resolved = await brands.resolveByName([BRAND]);

    brandId = resolved.get(BRAND) as ID;

    namedId = await makeBottling(`${TOKEN} Named`, brandId);
    namelessId = await makeBottling(null);
    orphanId = await makeBottling(`${TOKEN} Orphan`);

    await makeOffer(namedId, 'sku-named', `Віскі ${TOKEN} Named 0,7л`);
    await makeOffer(namelessId, 'sku-nameless', `Віскі ${TOKEN} Raw 0,7л`);
  });

  afterEach(async () => {
    await dataSource.query(
      'DELETE FROM favorite WHERE "userId" = ANY($1::uuid[])',
      [[userA, userB]],
    );
    await dataSource.query(
      'DELETE FROM blacklist_product WHERE "userId" = ANY($1::uuid[])',
      [[userA, userB]],
    );
    await dataSource.query(
      'DELETE FROM blacklist_brand WHERE "userId" = ANY($1::uuid[])',
      [[userA, userB]],
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(
        'DELETE FROM store_product WHERE "storeId" = $1',
        [storeId],
      );
      await dataSource.query(
        'DELETE FROM product WHERE id = ANY($1::uuid[])',
        [[namedId, namelessId, orphanId]],
      );
      await dataSource.query('DELETE FROM brand WHERE id = $1', [brandId]);
      await dataSource.query('DELETE FROM store WHERE id = $1', [storeId]);
      await dataSource.query(
        'DELETE FROM "user" WHERE id = ANY($1::uuid[])',
        [[userA, userB]],
      );

      await closeIntegrationModule(moduleRef);
    }
  });

  it('answers three empty lists for a user with no entries', async () => {
    const details = await preferences.findDetailsByUserId(userA);

    expect(details).toEqual({
      favorites: [],
      blacklistProducts: [],
      blacklistBrands: [],
    });
  });

  it('partitions one user\'s favorite and blacklist rows', async () => {
    await preferences.addFavorites(userA, [namedId]);
    await preferences.addToBlacklist(userA, {
      productIds: [namelessId],
      brandIds: [brandId],
    });

    const details = await preferences.findDetailsByUserId(userA);

    expect(details.favorites.map((item) => item.productId))
      .toEqual([namedId]);
    expect(details.blacklistProducts.map((item) => item.productId))
      .toEqual([namelessId]);
    expect(details.blacklistBrands).toEqual([
      { name: BRAND, addedOn: expect.stringMatching(ADDED_ON) as string },
    ]);
  });

  it('resolves the fields the settings screen renders', async () => {
    await preferences.addFavorites(userA, [namedId]);

    const details = await preferences.findDetailsByUserId(userA);

    expect(details.favorites[0]).toEqual({
      productId: namedId,
      name: `${TOKEN} Named`,
      nameOrig: `Віскі ${TOKEN} Named 0,7л`,
      brand: BRAND,
      age: 12,
      abv: 43.5,
      volumeMl: 700,
      inStock: true,
      addedOn: expect.stringMatching(ADDED_ON) as string,
    });
  });

  it('orders each list newest first', async () => {
    await preferences.addFavorites(userA, [namedId]);
    await preferences.addFavorites(userA, [namelessId]);

    const details = await preferences.findDetailsByUserId(userA);

    expect(details.favorites.map((item) => item.productId))
      .toEqual([namelessId, namedId]);
  });

  it('falls back to the raw offer name for a nameless bottling', async () => {
    await preferences.addFavorites(userA, [namelessId]);

    const details = await preferences.findDetailsByUserId(userA);

    expect(details.favorites[0].name).toBeNull();
    expect(details.favorites[0].nameOrig).toBe(`Віскі ${TOKEN} Raw 0,7л`);
  });

  it('keeps a bottling no store lists visible and removable', async () => {
    /**
     * The lateral join must be LEFT: an inner join would silently drop this
     * entry — precisely the one the user opened the screen to remove.
     */
    await preferences.addToBlacklist(userA, {
      productIds: [orphanId],
      brandIds: [],
    });

    const details = await preferences.findDetailsByUserId(userA);

    expect(details.blacklistProducts[0]).toMatchObject({
      productId: orphanId,
      nameOrig: null,
      inStock: false,
    });
  });

  it('reports in stock when any offer of the bottling is', async () => {
    await makeOffer(namedId, 'sku-named-oos', `Віскі ${TOKEN} OOS`, false);
    await preferences.addFavorites(userA, [namedId]);

    const details = await preferences.findDetailsByUserId(userA);

    expect(details.favorites[0].inStock).toBe(true);
  });

  it("never includes another user's rows", async () => {
    await preferences.addFavorites(userB, [namedId]);
    await preferences.addToBlacklist(userB, {
      productIds: [namelessId],
      brandIds: [brandId],
    });

    const details = await preferences.findDetailsByUserId(userA);

    expect(details).toEqual({
      favorites: [],
      blacklistProducts: [],
      blacklistBrands: [],
    });
  });
});
