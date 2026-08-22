import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CoreBrandService } from '~core/brand';
import { CorePreferenceService } from '~core/preference';
import { CoreProductService } from '~core/product';
import { CorePushService } from '~core/push';
import type { ID } from '~types';

import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

const STAMP = Date.now();

const BRAND = `__it_push_brand_${STAMP}`;

const MAX_GAP_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const TODAY = new Date().toISOString().slice(0, 10);

/**
 * A calendar day `days` before {@link TODAY}, in UTC.
 *
 * @param days - How many days back.
 * @returns The day as `YYYY-MM-DD`.
 */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * The digest claim against a real database. The statement is one CTE chain —
 * drop detection, favorite/blacklist joins, and the atomic dedup claim — and
 * none of its guarantees (claim-once, blacklist respect, the previous-existing
 * -snapshot semantics, the stale-gap guard) can be checked without Postgres.
 */
describe('push digest claim (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let push: CorePushService;
  let preferences: CorePreferenceService;
  let products: CoreProductService;
  let brands: CoreBrandService;
  let userA: ID;
  let userB: ID;
  let brandId: ID;
  let storeId: ID;
  let productId: ID;
  let offerId: ID;

  /**
   * Creates a throwaway user.
   *
   * @param suffix - Distinguishes the row from the suite's other users.
   * @returns The new user id.
   */
  const makeUser = async (suffix: string): Promise<ID> => {
    const rows = await dataSource.query(
      `INSERT INTO "user" (name, password, active)
       VALUES ($1, 'x', false)
       RETURNING id`,
      [`itd${STAMP}${suffix}`.slice(0, 32)],
    ) as { id: ID }[];

    return rows[0].id;
  };

  /**
   * Creates a bottling with no match key, so nothing else can match it.
   *
   * @returns The new canonical product id.
   */
  const makeBottling = async (): Promise<ID> => {
    return products.createUnmatched({
      matchKey: null,
      name: `IT Push ${STAMP}`,
      brandId,
      typeId: null,
      countryId: null,
      age: 10,
      abv: null,
      volumeMl: null,
    });
  };

  /**
   * Creates one store offer of a bottling.
   *
   * @param product - The bottling to offer.
   * @param suffix - Distinguishes the SKU from the suite's other offers.
   * @param inStock - Current availability of the offer.
   * @returns The new offer id.
   */
  const makeOffer = async (
    product: ID,
    suffix: string,
    inStock = true,
  ): Promise<ID> => {
    const rows = await dataSource.query(
      `INSERT INTO store_product
         ("storeId", "productId", sku, url, "nameOrig", "inStock",
          "firstSeen", "lastSeen")
       VALUES ($1, $2, $3, 'https://x.example/p', 'IT Push Orig', $4,
               CURRENT_DATE, CURRENT_DATE)
       RETURNING id`,
      [storeId, product, `it-push-${STAMP}-${suffix}`, inStock],
    ) as { id: ID }[];

    return rows[0].id;
  };

  /**
   * Writes one price snapshot for an offer and day.
   *
   * @param offer - The offer the price belongs to.
   * @param capturedOn - The capture day (`YYYY-MM-DD`).
   * @param price - The recorded price.
   */
  const makeSnapshot = async (
    offer: ID,
    capturedOn: string,
    price: number,
  ): Promise<void> => {
    await dataSource.query(
      `INSERT INTO price_snapshot
         ("storeProductId", price, currency, "inStock", promo, "capturedOn")
       VALUES ($1, $2, 'UAH', true, false, $3::date)`,
      [offer, price, capturedOn],
    );
  };

  /**
   * Subscribes a user with a unique throwaway endpoint.
   *
   * @param userId - The subscribing user.
   * @param suffix - Distinguishes the endpoint.
   */
  const subscribe = async (userId: ID, suffix: string): Promise<void> => {
    await push.subscribe(
      userId,
      {
        endpoint: `https://push.example/it/${STAMP}/${suffix}`,
        p256dh: 'key',
        auth: 'auth',
      },
      null,
    );
  };

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    push = moduleRef.get(CorePushService, { strict: false });
    preferences = moduleRef.get(CorePreferenceService, { strict: false });
    products = moduleRef.get(CoreProductService, { strict: false });
    brands = moduleRef.get(CoreBrandService, { strict: false });

    userA = await makeUser('a');
    userB = await makeUser('b');

    const resolved = await brands.resolveByName([BRAND]);

    brandId = resolved.get(BRAND) as ID;

    const stores = await dataSource.query(
      `INSERT INTO store (slug, name, "baseUrl", active)
       VALUES ($1, 'IT Push Store', 'https://x.example', true)
       RETURNING id`,
      [`it-push-${STAMP}`.slice(0, 32)],
    ) as { id: ID }[];

    storeId = stores[0].id;

    await subscribe(userA, 'a');
  });

  beforeEach(async () => {
    productId = await makeBottling();
    offerId = await makeOffer(productId, 'main');

    await preferences.addFavorites(userA, [productId]);
  });

  afterEach(async () => {
    await dataSource.query(
      'DELETE FROM store_product WHERE "storeId" = $1',
      [storeId],
    );
    await dataSource.query(
      'DELETE FROM product WHERE id = $1',
      [productId],
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query(
        'DELETE FROM "user" WHERE id = ANY($1::uuid[])',
        [[userA, userB]],
      );
      await dataSource.query('DELETE FROM store WHERE id = $1', [storeId]);
      await dataSource.query('DELETE FROM brand WHERE id = $1', [brandId]);

      await closeIntegrationModule(moduleRef);
    }
  });

  it('claims a drop once and returns it fully resolved', async () => {
    await makeSnapshot(offerId, daysAgo(1), 1000);
    await makeSnapshot(offerId, TODAY, 880);

    const first = await push.claimDrops(TODAY, MAX_GAP_DAYS);
    const again = await push.claimDrops(TODAY, MAX_GAP_DAYS);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      userId: userA,
      productId,
      storeProductId: offerId,
      name: `IT Push ${STAMP}`,
      nameOrig: 'IT Push Orig',
      age: 10,
      storeName: 'IT Push Store',
      price: 880,
      previousPrice: 1000,
      currency: 'UAH',
      discountPct: 12,
    });
    expect(again).toHaveLength(0);
  });

  it('sees no drop in a first-ever snapshot', async () => {
    await makeSnapshot(offerId, TODAY, 880);

    expect(await push.claimDrops(TODAY, MAX_GAP_DAYS)).toHaveLength(0);
  });

  it('sees no drop when the price did not fall', async () => {
    await makeSnapshot(offerId, daysAgo(1), 880);
    await makeSnapshot(offerId, TODAY, 880);

    expect(await push.claimDrops(TODAY, MAX_GAP_DAYS)).toHaveLength(0);
  });

  it('measures across an out-of-stock gap within the guard', async () => {
    await makeSnapshot(offerId, daysAgo(5), 1000);
    await makeSnapshot(offerId, TODAY, 880);

    const drops = await push.claimDrops(TODAY, MAX_GAP_DAYS);

    expect(drops).toHaveLength(1);
    expect(drops[0].previousPrice).toBe(1000);
  });

  it('ignores a previous snapshot older than the stale-gap guard', async () => {
    await makeSnapshot(offerId, daysAgo(MAX_GAP_DAYS + 1), 1000);
    await makeSnapshot(offerId, TODAY, 880);

    expect(await push.claimDrops(TODAY, MAX_GAP_DAYS)).toHaveLength(0);
  });

  it('respects the product blacklist', async () => {
    await preferences.addToBlacklist(userA, {
      productIds: [productId],
      brandIds: [],
    });
    await makeSnapshot(offerId, daysAgo(1), 1000);
    await makeSnapshot(offerId, TODAY, 880);

    expect(await push.claimDrops(TODAY, MAX_GAP_DAYS)).toHaveLength(0);
  });

  it('respects the brand blacklist while keeping the favorite', async () => {
    await preferences.addToBlacklist(userA, {
      productIds: [],
      brandIds: [brandId],
    });
    await makeSnapshot(offerId, daysAgo(1), 1000);
    await makeSnapshot(offerId, TODAY, 880);

    expect(await push.claimDrops(TODAY, MAX_GAP_DAYS)).toHaveLength(0);

    await preferences.removeFromBlacklist(userA, {
      productIds: [],
      brandIds: [brandId],
    });
  });

  it('skips an offer that is currently out of stock', async () => {
    const goneOffer = await makeOffer(productId, 'oos', false);

    await makeSnapshot(goneOffer, daysAgo(1), 1000);
    await makeSnapshot(goneOffer, TODAY, 880);

    expect(await push.claimDrops(TODAY, MAX_GAP_DAYS)).toHaveLength(0);
  });

  it('skips users with no subscription and foreign favorites', async () => {
    /**
     * User B favorites the bottling too but never subscribed, so the claim
     * must produce user A's row alone — the `EXISTS` guard, not the join,
     * is what keeps B out.
     */
    await preferences.addFavorites(userB, [productId]);
    await makeSnapshot(offerId, daysAgo(1), 1000);
    await makeSnapshot(offerId, TODAY, 880);

    const drops = await push.claimDrops(TODAY, MAX_GAP_DAYS);

    expect(drops).toHaveLength(1);
    expect(drops[0].userId).toBe(userA);
  });

  it('claims each store offer of one bottling separately', async () => {
    const secondOffer = await makeOffer(productId, 'second');

    await makeSnapshot(offerId, daysAgo(1), 1000);
    await makeSnapshot(offerId, TODAY, 880);
    await makeSnapshot(secondOffer, daysAgo(1), 900);
    await makeSnapshot(secondOffer, TODAY, 855);

    const drops = await push.claimDrops(TODAY, MAX_GAP_DAYS);

    expect(drops).toHaveLength(2);
    expect(drops.map((row) => row.discountPct).sort()).toEqual([12, 5].sort());
  });

  it('prunes only dedup rows older than the retention bound', async () => {
    await makeSnapshot(offerId, daysAgo(1), 1000);
    await makeSnapshot(offerId, TODAY, 880);
    await push.claimDrops(TODAY, MAX_GAP_DAYS);

    await push.pruneDigestLog(daysAgo(MAX_GAP_DAYS));

    const kept = await dataSource.query(
      'SELECT count(*)::int AS count FROM push_digest_log WHERE "userId" = $1',
      [userA],
    ) as { count: number }[];

    expect(kept[0].count).toBe(1);

    await push.pruneDigestLog(daysAgo(-1));

    const gone = await dataSource.query(
      'SELECT count(*)::int AS count FROM push_digest_log WHERE "userId" = $1',
      [userA],
    ) as { count: number }[];

    expect(gone[0].count).toBe(0);
  });

  it('upserts the endpoint and reassigns it to the last user', async () => {
    const endpoint = `https://push.example/it/${STAMP}/shared`;

    await push.subscribe(
      userA,
      { endpoint, p256dh: 'key', auth: 'auth' },
      'agent-a',
    );

    const devices = await push.subscribe(
      userB,
      { endpoint, p256dh: 'key2', auth: 'auth2' },
      'agent-b',
    );

    expect(devices).toHaveLength(1);

    const forA = await push.findDevicesByUserId(userA);

    /**
     * User A keeps only the suite's base subscription — the shared endpoint
     * moved to user B instead of duplicating.
     */
    expect(forA).toHaveLength(1);

    await push.unsubscribe(userB, endpoint);
  });
});
