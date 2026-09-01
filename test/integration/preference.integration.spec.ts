import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CorePreferenceService } from '~core/preference';
import { CoreProducerService } from '~core/producer';
import { CoreProductService } from '~core/product';
import { KbStatus, ProducerKind } from '~enums';
import type { ID } from '~types';

import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

const STAMP = Date.now();

const BRAND = `__it_pref_brand_${STAMP}`;

const BRAND_SLUG = `it-pref-brand-${STAMP}`;

const MISSING_PRODUCT_ID = '0198d1f6-0000-7000-8000-00000000dead' as ID;

/**
 * The per-user preference tables against a real database. Three claims carry
 * the feature and none of them can be checked without Postgres: the writes are
 * idempotent, hiding a bottling drops it from the favorites *atomically*, and
 * neither ever reaches another user's rows.
 */
describe('user preferences (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let preferences: CorePreferenceService;
  let products: CoreProductService;
  let producers: CoreProducerService;
  let userA: ID;
  let userB: ID;
  let producerId: ID;
  let productId: ID;
  let otherProductId: ID;

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
      [`itp${STAMP}${suffix}`.slice(0, 32)],
    ) as { id: ID }[];

    return rows[0].id;
  };

  /**
   * Creates a bottling with no match key, so nothing else can match it.
   *
   * @param producer - Producer to attach, when the test needs one. Written
   *   after the insert because `createUnmatched` writes facts, not the
   *   knowledge base's own columns — `SET_PRODUCERS_SQL` owns those.
   * @returns The new canonical product id.
   */
  const makeBottling = async (producer?: ID): Promise<ID> => {
    const id = await products.createUnmatched({
      factSources: {},
      matchKey: null,
      name: `IT Pref ${STAMP}`,
      brandOrig: null,
      typeId: null,
      countryId: null,
      age: null,
      abv: null,
      volumeMl: null,
    });

    if (producer !== undefined) {
      await dataSource.query(
        'UPDATE product SET "producerId" = $1 WHERE id = $2',
        [producer, id],
      );
    }

    return id;
  };

  /**
   * Counts rows in one preference table for one user.
   *
   * @param table - Table to count in.
   * @param userId - Whose rows to count.
   * @returns The row count.
   */
  const countRows = async (table: string, userId: ID): Promise<number> => {
    const rows = await dataSource.query(
      `SELECT count(*)::int AS count FROM ${table} WHERE "userId" = $1`,
      [userId],
    ) as { count: number }[];

    return rows[0].count;
  };

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    preferences = moduleRef.get(CorePreferenceService, { strict: false });
    products = moduleRef.get(CoreProductService, { strict: false });
    producers = moduleRef.get(CoreProducerService, { strict: false });

    userA = await makeUser('a');
    userB = await makeUser('b');

    const seeded = await dataSource.query(
      `INSERT INTO producer (slug, name, kind, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [BRAND_SLUG, BRAND, ProducerKind.DISTILLERY, KbStatus.AUTO],
    ) as { id: ID }[];

    producerId = seeded[0].id;
  });

  beforeEach(async () => {
    productId = await makeBottling(producerId);
    otherProductId = await makeBottling();
  });

  afterEach(async () => {
    await dataSource.query(
      'DELETE FROM product WHERE id = ANY($1::uuid[])',
      [[productId, otherProductId]],
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(
        'DELETE FROM "user" WHERE id = ANY($1::uuid[])',
        [[userA, userB]],
      );
      await dataSource.query(
        'DELETE FROM producer WHERE id = $1',
        [producerId],
      );

      await closeIntegrationModule(moduleRef);
    }
  });

  it('adds a favorite once, however often it is sent', async () => {
    await preferences.addFavorites(userA, [productId]);

    const state = await preferences.addFavorites(userA, [
      productId,
      productId,
    ]);

    expect(state.favorites).toEqual([productId]);
    expect(await countRows('favorite', userA)).toBe(1);
  });

  it('reads product ids and brand names, empty when unset', async () => {
    const empty = await preferences.findByUserId(userB);

    expect(empty).toEqual({
      favorites: [],
      blacklistProducts: [],
      blacklistBrands: [],
    });

    await preferences.addFavorites(userA, [productId]);
    await preferences.addToBlacklist(userA, {
      productIds: [otherProductId],
      producerIds: [producerId],
    });

    const state = await preferences.findByUserId(userA);

    expect(state.favorites).toEqual([productId]);
    expect(state.blacklistProducts).toEqual([otherProductId]);
    expect(state.blacklistBrands).toEqual([BRAND]);
  });

  it('stamps createdAt for the future management screen', async () => {
    await preferences.addFavorites(userA, [productId]);

    const rows = await dataSource.query(
      'SELECT "createdAt" FROM favorite WHERE "userId" = $1',
      [userA],
    ) as { createdAt: Date | null }[];

    expect(rows[0].createdAt).not.toBeNull();
  });

  it('removes entries that were never there without complaining', async () => {
    const state = await preferences.removeFavorites(userA, [productId]);

    expect(state.favorites).toEqual([]);
  });

  it('drops a bottling from the favorites when it is blacklisted', async () => {
    await preferences.addFavorites(userA, [productId]);

    const state = await preferences.addToBlacklist(userA, {
      productIds: [productId],
      producerIds: [],
    });

    expect(state.favorites).toEqual([]);
    expect(state.blacklistProducts).toEqual([productId]);
  });

  it('keeps the favorite when the whole brand is blacklisted', async () => {
    await preferences.addFavorites(userA, [productId]);

    const state = await preferences.addToBlacklist(userA, {
      productIds: [],
      producerIds: [producerId],
    });

    /**
     * The asymmetry is deliberate: the report hides this favorite while the
     * brand rule stands, so lifting the rule restores it instead of having
     * silently destroyed it.
     */
    expect(state.favorites).toEqual([productId]);
    expect(state.blacklistBrands).toEqual([BRAND]);
  });

  it('rolls the favorite deletion back when an insert fails', async () => {
    await preferences.addFavorites(userA, [productId]);

    const failure = preferences.addToBlacklist(userA, {
      productIds: [productId, MISSING_PRODUCT_ID],
      producerIds: [],
    });

    /**
     * The foreign key rejects the missing id. If the two statements were not
     * one transaction, the favorite would already be gone — this is the proof
     * `@Transactional()` reaches the repository's raw SQL.
     */
    await expect(failure).rejects.toThrow();

    const state = await preferences.findByUserId(userA);

    expect(state.favorites).toEqual([productId]);
    expect(state.blacklistProducts).toEqual([]);
  });

  it("never touches another user's rows", async () => {
    await preferences.addFavorites(userB, [productId]);
    await preferences.addToBlacklist(userA, {
      productIds: [productId],
      producerIds: [],
    });

    const other = await preferences.findByUserId(userB);

    expect(other.favorites).toEqual([productId]);
    expect(other.blacklistProducts).toEqual([]);
  });

  it('un-hides without restoring the favorite it gave up', async () => {
    await preferences.addFavorites(userA, [productId]);
    await preferences.addToBlacklist(userA, {
      productIds: [productId],
      producerIds: [producerId],
    });

    const state = await preferences.removeFromBlacklist(userA, {
      productIds: [productId],
      producerIds: [producerId],
    });

    expect(state.blacklistProducts).toEqual([]);
    expect(state.blacklistBrands).toEqual([]);
    expect(state.favorites).toEqual([]);
  });

  it('cascades when the product goes away', async () => {
    await preferences.addFavorites(userA, [productId]);
    await preferences.addToBlacklist(userA, {
      productIds: [productId],
      producerIds: [],
    });

    await dataSource.query('DELETE FROM product WHERE id = $1', [productId]);

    expect(await countRows('favorite', userA)).toBe(0);
    expect(await countRows('blacklist_product', userA)).toBe(0);
  });

  it('cascades when the user goes away', async () => {
    const doomed = await makeUser('c');

    await preferences.addFavorites(doomed, [productId]);
    await preferences.addToBlacklist(doomed, {
      productIds: [otherProductId],
      producerIds: [producerId],
    });

    await dataSource.query('DELETE FROM "user" WHERE id = $1', [doomed]);

    expect(await countRows('favorite', doomed)).toBe(0);
    expect(await countRows('blacklist_product', doomed)).toBe(0);
    expect(await countRows('blacklist_producer', doomed)).toBe(0);
  });

  it('resolves brand names without coining one', async () => {
    const novel = `__it_pref_absent_${STAMP}`;

    const resolved = await producers.findIdsByName([novel]);

    expect(resolved.size).toBe(0);

    const rows = await dataSource.query(
      'SELECT count(*)::int AS count FROM producer WHERE name = $1',
      [novel],
    ) as { count: number }[];

    /**
     * The regression guard for swapping this lookup back to `resolveByName`,
     * which would let one user's typo mint a row every other user then sees.
     */
    expect(rows[0].count).toBe(0);
  });
});
