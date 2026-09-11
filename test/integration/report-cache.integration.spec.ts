import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

/**
 * Set before anything reads the configuration, so the suite's entries cannot
 * collide with the ones a locally running application wrote and can be swept
 * whole afterwards.
 */
process.env.CACHE_VALKEY_PREFIX = `it:${Date.now()}:`;

import { CACHE_GENERATION_CATALOGUE } from '~constants';
import { CorePreferenceService } from '~core/preference';
import { CorePriceSnapshotService } from '~core/price-snapshot';
import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import { ReportKind, ReportWindow, SortOrder } from '~enums';
import { CacheModule, VersionedCacheService } from '~lib/cache';
import { ValkeyService } from '~lib/valkey';
import type { ID, ReportOptions } from '~types';

import { ReportService } from '../../src/domain/report/report.service';
import { clearCatalogue, withRolledBackFixture } from './database-fixture';
import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

const STAMP = Date.now();

const SLUG = `__it_cache_${STAMP}`;

const TOKEN = `itcache${STAMP}`;

const DAY = '2026-07-25';

const OPTIONS: ReportOptions = {
  window: ReportWindow.WEEK,
  order: SortOrder.ASC,
  page: 1,
  perPage: 50,
};

/**
 * What the fixture measured, gathered inside the transaction and asserted
 * after it has rolled back.
 */
interface Gathered {
  firstIds: ID[];
  queriesAfterFirst: number;
  queriesAfterSecond: number;
  queriesAfterBump: number;
  queriesAfterSecondPage: number;
  queriesAfterOtherFilter: number;
  idsForUserB: ID[];
  idsForUserAAfterHiding: ID[];
  queriesAfterHiding: number;
  generationBefore: number | null;
  generationAfter: number | null;
}

describe('the catalogue cache over the live report (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let cache: VersionedCacheService;
  let gathered: Gathered;

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule([CacheModule]);
    dataSource = moduleRef.get(DataSource);
    cache = moduleRef.get(VersionedCacheService, { strict: false });

    const products = moduleRef.get(CoreProductService, { strict: false });
    const offers = moduleRef.get(CoreStoreProductService, { strict: false });
    const snapshots = moduleRef.get(CorePriceSnapshotService, {
      strict: false,
    });
    const preferences = moduleRef.get(CorePreferenceService, {
      strict: false,
    });

    const service = new ReportService(offers, snapshots, preferences, cache);

    /**
     * The query the cache is meant to save. Counting its calls is the only
     * honest way to tell a hit from a miss — the answer looks the same
     * either way.
     */
    const query = jest.spyOn(offers, 'findCurrentRows');

    gathered = await withRolledBackFixture(async () => {
      await clearCatalogue(dataSource);

      /**
       * Real rows, because the blacklist has a foreign key to `user`. They
       * are rolled back with everything else.
       *
       * @param suffix - Distinguishes the two users.
       * @returns The new user's id.
       */
      const makeUser = async (suffix: string): Promise<ID> => {
        const rows = await dataSource.query(
          `INSERT INTO "user" (name, password, active)
           VALUES ($1, 'x', false)
           RETURNING id`,
          [`itcache${STAMP}${suffix}`.slice(0, 32)],
        ) as { id: ID }[];

        return rows[0].id;
      };

      const userA = await makeUser('a');
      const userB = await makeUser('b');

      const storeRows = await dataSource.query(
        `INSERT INTO store (slug, name, "baseUrl", active)
         VALUES ($1, 'IT Cache', 'https://example.test', true)
         RETURNING id`,
        [SLUG],
      ) as { id: ID }[];

      /**
       * Seeds one bottling with one offer at one price.
       *
       * @param key - Distinguishes the bottling and its SKU.
       * @param price - The price to record.
       * @returns The new bottling's id.
       */
      const seed = async (key: string, price: number): Promise<ID> => {
        const { ids } = await products.findOrCreateByMatchKeys([
          {
            factSources: {},
            matchKey: `${TOKEN}-${key}`,
            name: `${TOKEN} ${key}`,
            brandOrig: null,
            typeId: null,
            countryId: null,
            age: null,
            abv: null,
            volumeMl: 700,
          },
        ]);

        const productId = [...ids.values()][0];

        const offer = await offers.upsertFromScrape({
          storeId: storeRows[0].id,
          productId,
          sku: `sku-${key}`,
          url: `https://example.test/${key}`,
          nameOrig: `${TOKEN} ${key}`,
          seenOn: DAY,
        });

        if (!offer) {
          throw new Error('Offer upsert returned nothing');
        }

        await snapshots.upsertForDate(offer.id, DAY, {
          price,
          oldPrice: null,
          currency: 'UAH',
          inStock: true,
          promo: false,
        });

        return productId;
      };

      const first = await seed('one', 1000);

      await seed('two', 1100);

      /**
       * Runs the catalog report scoped to the seeded rows.
       *
       * @param userId - Who the report is for.
       * @param page - Which page to ask for.
       * @param name - The name filter, so a second shape can be requested.
       * @returns The bottling ids the report answered with.
       */
      const run = async (
        userId: ID,
        page = 1,
        name: string = TOKEN,
      ): Promise<ID[]> => {
        const result = await service.report(
          ReportKind.CATALOG,
          { name },
          { ...OPTIONS, page },
          { userId },
        );

        return result.data.map((group) => group.productId);
      };

      const generationBefore = await cache.readGeneration(
        CACHE_GENERATION_CATALOGUE,
      );

      query.mockClear();

      const firstIds = await run(userA);
      const queriesAfterFirst = query.mock.calls.length;

      await run(userA);

      const queriesAfterSecond = query.mock.calls.length;

      const idsForUserB = await run(userB);

      await run(userA, 2);

      const queriesAfterSecondPage = query.mock.calls.length;

      await run(userA, 1, `${TOKEN} one`);

      const queriesAfterOtherFilter = query.mock.calls.length;

      await cache.bump(CACHE_GENERATION_CATALOGUE, 'test');

      await run(userA);

      const queriesAfterBump = query.mock.calls.length;

      await preferences.addToBlacklist(userA, {
        productIds: [first],
        producerIds: [],
      });

      const idsForUserAAfterHiding = await run(userA);
      const queriesAfterHiding = query.mock.calls.length;

      const generationAfter = await cache.readGeneration(
        CACHE_GENERATION_CATALOGUE,
      );

      return {
        firstIds,
        queriesAfterFirst,
        queriesAfterSecond,
        queriesAfterBump,
        queriesAfterSecondPage,
        queriesAfterOtherFilter,
        idsForUserB,
        idsForUserAAfterHiding,
        queriesAfterHiding,
        generationBefore,
        generationAfter,
      };
    });

    query.mockRestore();
  });

  afterAll(async () => {
    /**
     * The entries outlive the fixture's rollback — they are in Valkey, not
     * in the transaction — so the suite sweeps its own prefix. `keys` is
     * safe here in a way it would not be in the application: the pattern is
     * this run's alone and matches a handful of entries.
     */
    const client = moduleRef.get(ValkeyService, { strict: false }).getClient();
    const prefix = process.env.CACHE_VALKEY_PREFIX ?? '';
    const keys = await client.keys(`${prefix}*`);

    if (keys.length) {
      await client.del(...keys);
    }

    await closeIntegrationModule(moduleRef);
  });

  it('answers the first request from the database', () => {
    expect(gathered.firstIds).toHaveLength(2);
    expect(gathered.queriesAfterFirst).toBe(1);
  });

  it('answers an identical request without touching the database', () => {
    expect(gathered.queriesAfterSecond).toBe(1);
  });

  it('serves every page of a report from one entry', () => {
    /**
     * The cached set is the whole match, sliced after it is read. A key that
     * carried the page would make each one its own full recomputation.
     */
    expect(gathered.queriesAfterSecondPage).toBe(1);
  });

  it('serves a second user from the same entry', () => {
    /**
     * The point of moving the blacklists out of the query: the expensive
     * half is the same for everybody, so it is computed once for all of
     * them.
     */
    expect(gathered.idsForUserB).toEqual(gathered.firstIds);
    expect(gathered.queriesAfterSecondPage).toBe(1);
  });

  it('computes a different filter separately', () => {
    expect(gathered.queriesAfterOtherFilter).toBe(2);
  });

  it('recomputes after the generation moves', () => {
    expect(gathered.generationAfter)
      .toBeGreaterThan(gathered.generationBefore ?? 0);

    expect(gathered.queriesAfterBump).toBe(3);
  });

  it('applies a new preference at once, with nothing invalidated', () => {
    /**
     * The assertion the whole personalization split exists for. Hiding a
     * bottling changes what this user sees on the very next request, and it
     * costs no recomputation and no invalidation, because the cached set
     * belongs to nobody and the filter runs per request.
     */
    expect(gathered.idsForUserAAfterHiding).toHaveLength(1);
    expect(gathered.queriesAfterHiding).toBe(3);
  });
});
