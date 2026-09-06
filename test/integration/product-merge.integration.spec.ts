import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import { FactSource, FlavorSource, ProductFactField } from '~enums';
import type { ID, ProductCanonicalInput } from '~types';

import { ensureFlavors } from './database-fixture';
import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

const STAMP = Date.now();

/**
 * Prefixes every throwaway row this suite creates, so cleanup and manual
 * inspection can both tell them apart from the shared development data.
 */
const TOKEN = `itmerge${STAMP}`;

const SLUG = `__it_merge_${STAMP}`;

const DAY = '2026-09-06';

/**
 * The merge, the alias table and the identity fallback against the live
 * database — the parts of the duplicate work that are SQL and cannot be
 * unit-tested: a merge moves every dependant and deletes the source, the
 * vanishing key resolves to the survivor afterwards, a listing whose key is
 * unknown joins the row that shares its name, volume and age, and a relink
 * moves one offer and only that offer.
 */
describe('product merge and identity resolution (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let products: CoreProductService;
  let offers: CoreStoreProductService;
  let storeId: ID;
  let userId: ID;
  let peatedId: ID;
  let sherryId: ID;

  /**
   * A bottling of this suite, keyed and named with the run's token.
   *
   * @param over - Fields to override.
   * @returns The insert input.
   */
  const bottling = (
    over: Partial<ProductCanonicalInput> = {},
  ): ProductCanonicalInput => ({
    factSources: {},
    matchKey: `${TOKEN}-key`,
    name: `${TOKEN} Sample`,
    brandOrig: null,
    typeId: null,
    countryId: null,
    age: 12,
    abv: null,
    volumeMl: 700,
    ...over,
  });

  /**
   * Creates a bottling and returns its id.
   *
   * @param over - Fields to override.
   * @returns The new canonical id.
   */
  const makeBottling = async (
    over: Partial<ProductCanonicalInput> = {},
  ): Promise<ID> => {
    const { ids } = await products.findOrCreateByMatchKeys([bottling(over)]);

    return [...ids.values()][0];
  };

  /**
   * Creates one offer of a bottling.
   *
   * @param productId - The bottling offered.
   * @param sku - The store's SKU.
   * @returns The offer id.
   */
  const makeOffer = async (productId: ID, sku: string): Promise<ID> => {
    const offer = await offers.upsertFromScrape({
      storeId,
      productId,
      sku: `${TOKEN}-${sku}`,
      url: `https://example.test/${TOKEN}/${sku}`,
      nameOrig: `Віскі ${TOKEN} ${sku}`,
      seenOn: DAY,
    });

    if (!offer) {
      throw new Error('Offer upsert returned nothing');
    }

    return offer.id;
  };

  /**
   * Reads one row of any table by id.
   *
   * @param table - The table.
   * @param id - The row id.
   * @returns The row, or undefined.
   */
  const rowOf = async (
    table: string,
    id: ID,
  ): Promise<Record<string, unknown> | undefined> => {
    const rows = await dataSource.query(
      `SELECT * FROM ${table} WHERE id = $1`,
      [id],
    ) as Record<string, unknown>[];

    return rows[0];
  };

  /**
   * The product ids the given offers point at, in the order asked.
   *
   * @param ids - Offer ids.
   * @returns Their bottling ids.
   */
  const linkedTo = async (ids: ID[]): Promise<ID[]> => {
    const rows = await dataSource.query(
      `SELECT sp.id, sp."productId" FROM store_product sp
       WHERE sp.id = ANY($1::uuid[])`,
      [ids],
    ) as { id: ID; productId: ID }[];

    return ids.map((id) => rows.find((row) => row.id === id)?.productId as ID);
  };

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    products = moduleRef.get(CoreProductService, { strict: false });
    offers = moduleRef.get(CoreStoreProductService, { strict: false });

    const stores = await dataSource.query(
      `INSERT INTO store (slug, name, "baseUrl", active)
       VALUES ($1, 'IT Merge', 'https://example.test', true)
       RETURNING id`,
      [SLUG],
    ) as { id: ID }[];

    storeId = stores[0].id;

    await dataSource.query(
      `INSERT INTO store_config
         ("storeId", tier, "delayFrom", "delayTo", "needsBrowser", engine)
       VALUES ($1, 1, 0, 0, false, 'ts')`,
      [storeId],
    );

    const users = await dataSource.query(
      `INSERT INTO "user" (name, password, active)
       VALUES ($1, 'x', false)
       RETURNING id`,
      [TOKEN.slice(0, 32)],
    ) as { id: ID }[];

    userId = users[0].id;

    const flavors = await ensureFlavors(dataSource, ['peated', 'sherry']);

    peatedId = flavors.get('peated') as ID;
    sherryId = flavors.get('sherry') as ID;
  });

  afterEach(async () => {
    await dataSource.query(
      'DELETE FROM store_product WHERE "storeId" = $1',
      [storeId],
    );
    await dataSource.query(
      'DELETE FROM user_collection WHERE "userId" = $1',
      [userId],
    );
    await dataSource.query(
      'DELETE FROM product WHERE name LIKE $1 OR "matchKey" LIKE $1',
      [`${TOKEN}%`],
    );
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM "user" WHERE id = $1', [userId]);
    await dataSource.query('DELETE FROM store WHERE id = $1', [storeId]);
    await closeIntegrationModule(moduleRef);
  });

  describe('mergeInto', () => {
    it('moves everything the vanishing row owned and deletes it', async () => {
      const survivor = await makeBottling({
        matchKey: `${TOKEN}-keep`,
        name: `${TOKEN} Keep`,
        abv: 40,
        factSources: { [ProductFactField.ABV]: FactSource.NAME },
      });

      const loser = await makeBottling({
        matchKey: `${TOKEN}-lose`,
        name: `${TOKEN} Lose`,
        abv: 43,
        factSources: { [ProductFactField.ABV]: FactSource.STORE },
      });

      const keptOffer = await makeOffer(survivor, 'keep');
      const movedOffer = await makeOffer(loser, 'lose');

      await products.addScrapeFlavors([
        { productId: survivor, flavorId: peatedId },
        { productId: loser, flavorId: peatedId },
        { productId: loser, flavorId: sherryId },
      ]);

      await dataSource.query(
        `UPDATE product_flavor SET source = $3
         WHERE "productId" = $1 AND "flavorId" = $2`,
        [loser, peatedId, FlavorSource.LLM],
      );

      await dataSource.query(
        `INSERT INTO favorite ("userId", "productId")
         VALUES ($1, $2), ($1, $3)`,
        [userId, survivor, loser],
      );

      const collections = await dataSource.query(
        `INSERT INTO user_collection ("userId", "productId", rating)
         VALUES ($1, $2, 8), ($1, $3, 6)
         RETURNING id, "productId"`,
        [userId, survivor, loser],
      ) as { id: ID; productId: ID }[];

      const loserCollection = collections.find(
        (row) => row.productId === loser,
      ) as { id: ID };

      const keptCollection = collections.find(
        (row) => row.productId === survivor,
      ) as { id: ID };

      await dataSource.query(
        `INSERT INTO user_collection_purchase ("collectionId", price)
         VALUES ($1, 1200)`,
        [loserCollection.id],
      );

      await products.mergeInto(loser, survivor);

      expect(await rowOf('product', loser)).toBeUndefined();
      expect(await linkedTo([keptOffer, movedOffer])).toEqual([
        survivor,
        survivor,
      ]);

      const kept = await rowOf('product', survivor);

      /**
       * `store` outranks `name`, so the vanishing row's strength replaces the
       * survivor's; the name is a person's decision on neither side and stays.
       */
      expect(kept?.abv).toBe(43);
      expect(kept?.abvSource).toBe(FactSource.STORE);
      expect(kept?.name).toBe(`${TOKEN} Keep`);
      expect(kept?.matchKey).toBe(`${TOKEN}-keep`);

      const links = await dataSource.query(
        `SELECT "flavorId", source FROM product_flavor
         WHERE "productId" = $1 ORDER BY source`,
        [survivor],
      ) as { flavorId: ID; source: string }[];

      /**
       * The shared tag keeps the better-trusted `llm` source; the sherry tag
       * simply comes along.
       */
      expect(links).toEqual(
        expect.arrayContaining([
          { flavorId: peatedId, source: FlavorSource.LLM },
          { flavorId: sherryId, source: FlavorSource.SCRAPE },
        ]),
      );
      expect(links).toHaveLength(2);

      const favorites = await dataSource.query(
        'SELECT "productId" FROM favorite WHERE "userId" = $1',
        [userId],
      ) as { productId: ID }[];

      expect(favorites).toEqual([{ productId: survivor }]);

      const collectionRows = await dataSource.query(
        `SELECT id, "productId", rating::float8 AS rating
         FROM user_collection WHERE "userId" = $1`,
        [userId],
      ) as { id: ID; productId: ID; rating: number }[];

      /**
       * The user held both: the survivor's row (and its rating) stands, and
       * the other row's purchase moved onto it rather than being lost.
       */
      expect(collectionRows).toEqual([
        { id: keptCollection.id, productId: survivor, rating: 8 },
      ]);

      const purchases = await dataSource.query(
        `SELECT price::float8 AS price FROM user_collection_purchase
         WHERE "collectionId" = $1`,
        [keptCollection.id],
      ) as { price: number }[];

      expect(purchases).toEqual([{ price: 1200 }]);

      const aliases = await dataSource.query(
        'SELECT key FROM product_match_alias WHERE "productId" = $1',
        [survivor],
      ) as { key: string }[];

      expect(aliases).toEqual([{ key: `${TOKEN}-lose` }]);

      await dataSource.query('DELETE FROM favorite WHERE "userId" = $1', [
        userId,
      ]);
    });

    it('lets the manual values of the vanishing row win', async () => {
      const survivor = await makeBottling({
        matchKey: `${TOKEN}-keep`,
        name: `${TOKEN} Keep`,
        age: null,
      });

      const loser = await makeBottling({
        matchKey: `${TOKEN}-lose`,
        name: `${TOKEN} Lose`,
        age: 12,
        factSources: {
          [ProductFactField.NAME]: FactSource.MANUAL,
          [ProductFactField.AGE]: FactSource.MANUAL,
        },
      });

      await products.mergeInto(loser, survivor);

      const kept = await rowOf('product', survivor);

      expect(kept?.name).toBe(`${TOKEN} Lose`);
      expect(kept?.nameSource).toBe(FactSource.MANUAL);
      expect(kept?.age).toBe(12);
      expect(kept?.ageSource).toBe(FactSource.MANUAL);
    });

    it('does not fill a NAS survivor from an automatic age', async () => {
      const survivor = await makeBottling({
        matchKey: `${TOKEN}-keep`,
        name: `${TOKEN} Keep`,
        age: null,
      });

      const loser = await makeBottling({
        matchKey: `${TOKEN}-lose`,
        name: `${TOKEN} Lose`,
        age: 4,
        factSources: { [ProductFactField.AGE]: FactSource.NAME },
      });

      await products.mergeInto(loser, survivor);

      expect((await rowOf('product', survivor))?.age).toBeNull();
    });

    it('hands the key to a keyless survivor, not an alias', async () => {
      const survivor = await products.createUnmatched(bottling({
        matchKey: null,
        name: `${TOKEN} Keep`,
      }));

      const loser = await makeBottling({
        matchKey: `${TOKEN}-lose`,
        name: `${TOKEN} Lose`,
      });

      await products.mergeInto(loser, survivor);

      expect((await rowOf('product', survivor))?.matchKey).toBe(
        `${TOKEN}-lose`,
      );

      const aliases = await dataSource.query(
        'SELECT key FROM product_match_alias WHERE "productId" = $1',
        [survivor],
      ) as unknown[];

      expect(aliases).toHaveLength(0);
    });

    it('replaces automatic tags with a curated set that arrives', async () => {
      const survivor = await makeBottling({
        matchKey: `${TOKEN}-keep`,
        name: `${TOKEN} Keep`,
      });

      const loser = await makeBottling({
        matchKey: `${TOKEN}-lose`,
        name: `${TOKEN} Lose`,
      });

      await products.addScrapeFlavors([
        { productId: survivor, flavorId: peatedId },
      ]);
      await products.setManualFlavors(loser, [sherryId]);

      await products.mergeInto(loser, survivor);

      const links = await dataSource.query(
        'SELECT "flavorId", source FROM product_flavor WHERE "productId" = $1',
        [survivor],
      ) as { flavorId: ID; source: string }[];

      expect(links).toEqual([{
        flavorId: sherryId,
        source: FlavorSource.MANUAL,
      }]);
      expect((await rowOf('product', survivor))?.flavorsCuratedAt).not
        .toBeNull();
    });
  });

  describe('findOrCreateByMatchKeys', () => {
    it('resolves a retired key to the survivor', async () => {
      const survivor = await makeBottling({
        matchKey: `${TOKEN}-keep`,
        name: `${TOKEN} Keep`,
      });

      const loser = await makeBottling({
        matchKey: `${TOKEN}-lose`,
        name: `${TOKEN} Lose`,
      });

      await products.mergeInto(loser, survivor);

      const { ids, added } = await products.findOrCreateByMatchKeys([
        bottling({ matchKey: `${TOKEN}-lose`, name: `${TOKEN} Lose` }),
      ]);

      expect(added).toBe(0);
      expect(ids.get(`${TOKEN}-lose`)).toBe(survivor);

      const known = await products.findByMatchKeys([`${TOKEN}-lose`]);

      expect(known.get(`${TOKEN}-lose`)?.id).toBe(survivor);
    });

    it('joins a bottling by identity when the key is unknown', async () => {
      const existing = await makeBottling({
        matchKey: `${TOKEN}-first`,
        name: `${TOKEN} Double Wood`,
        age: 12,
        volumeMl: 700,
      });

      const { ids, added } = await products.findOrCreateByMatchKeys([
        bottling({
          matchKey: `${TOKEN}-other-brand-token`,
          name: `${TOKEN} DoubleWood`,
          age: 12,
          volumeMl: 700,
        }),
        bottling({
          matchKey: `${TOKEN}-other-size`,
          name: `${TOKEN} Double Wood`,
          age: 12,
          volumeMl: 1000,
        }),
      ]);

      /**
       * Same name (punctuation aside), volume and age: the first joins the
       * existing row. A different volume is a different bottling and is
       * created.
       */
      expect(ids.get(`${TOKEN}-other-brand-token`)).toBe(existing);
      expect(ids.get(`${TOKEN}-other-size`)).not.toBe(existing);
      expect(added).toBe(1);
    });
  });

  describe('relink', () => {
    it('moves one offer and leaves the rest of the group alone', async () => {
      const from = await makeBottling({
        matchKey: `${TOKEN}-from`,
        name: `${TOKEN} From`,
      });

      const to = await makeBottling({
        matchKey: `${TOKEN}-to`,
        name: `${TOKEN} To`,
      });

      const moved = await makeOffer(from, 'moved');
      const stays = await makeOffer(from, 'stays');

      const previous = await offers.relink(moved, to);

      expect(previous).toBe(from);
      expect(await linkedTo([moved, stays])).toEqual([to, from]);
    });

    it('deletes an emptied bottling only when unreferenced', async () => {
      const shell = await makeBottling({
        matchKey: `${TOKEN}-shell`,
        name: `${TOKEN} Shell`,
      });

      const listed = await makeBottling({
        matchKey: `${TOKEN}-listed`,
        name: `${TOKEN} Listed`,
      });

      await makeOffer(listed, 'listed');

      expect(await products.deleteIfUnreferenced(listed)).toBe(false);
      expect(await products.deleteIfUnreferenced(shell)).toBe(true);
      expect(await rowOf('product', shell)).toBeUndefined();
      expect(await rowOf('product', listed)).toBeDefined();
    });
  });
});
