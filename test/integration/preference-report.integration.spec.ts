import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CorePreferenceService } from '~core/preference';
import { CorePriceSnapshotService } from '~core/price-snapshot';
import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import {
  KbStatus,
  ProducerKind,
  ReportKind,
  ReportWindow,
  SortOrder,
} from '~enums';
import type { ID, ReportFilter, ReportGroup, ReportOptions } from '~types';

import { ReportService } from '../../src/domain/report/report.service';
import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

const STAMP = Date.now();

const SLUG_A = `__it_pr_a_${STAMP}`;

const SLUG_B = `__it_pr_b_${STAMP}`;

/**
 * A token no catalogue row can contain, so every assertion scopes itself to the
 * seeded rows through the report's own name filter — the suite then passes
 * against a local database restored from a production dump.
 */
const TOKEN = `itpr${STAMP}`;

const BRAND = `__it_pr_brand_${STAMP}`;

const BRAND_SLUG = `it-pr-brand-${STAMP}`;

const BOTTLER = `__it_pr_bottler_${STAMP}`;

const BOTTLER_SLUG = `it-pr-bottler-${STAMP}`;

const DAY = '2026-07-25';

const OPTIONS: ReportOptions = {
  window: ReportWindow.WEEK,
  order: SortOrder.ASC,
  page: 1,
  perPage: 50,
};

/**
 * The per-user report predicates against the live query. What matters here and
 * cannot be unit-tested: the blacklist hides a bottling on *every* report kind
 * and for that user alone, a brandless product survives a brand rule, and the
 * single-item paths stay reachable so the card that just hid a product still
 * works.
 */
describe('preference filtering over the live report query', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let products: CoreProductService;
  let offers: CoreStoreProductService;
  let snapshots: CorePriceSnapshotService;
  let preferences: CorePreferenceService;
  let service: ReportService;
  let storeA: ID;
  let storeB: ID;
  let userA: ID;
  let userB: ID;
  let producerId: ID;

  let bottlerId: ID;

  let bottledId: ID;
  let brandedId: ID;
  let siblingId: ID;
  let brandlessId: ID;
  let plainId: ID;

  /**
   * Runs a report with the seeded rows in scope.
   *
   * @param userId - Whose preferences apply.
   * @param filter - Extra filter fields on top of the name scoping.
   * @param kind - Which report to run.
   * @returns The report groups.
   */
  const run = async (
    userId: ID,
    filter: Partial<ReportFilter> = {},
    kind: ReportKind = ReportKind.CATALOG,
  ): Promise<ReportGroup[]> => {
    const page = await service.report(
      kind,
      { userId, name: TOKEN, ...filter },
      OPTIONS,
    );

    return page.data;
  };

  /**
   * The canonical ids a report answered with, sorted for comparison.
   *
   * @param groups - The report groups to read.
   * @returns Their bottling ids.
   */
  const idsOf = (groups: ReportGroup[]): ID[] => {
    return groups.map((group) => group.productId).sort();
  };

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
      [`itpr${STAMP}${suffix}`.slice(0, 32)],
    ) as { id: ID }[];

    return rows[0].id;
  };

  /**
   * Creates a bottling whose name carries the suite token.
   *
   * @param key - Suffix of its match key.
   * @param producer - Producer to attach, or null for a bottling the
   *   knowledge base cannot place.
   * @returns The new product id.
   */
  const makeBottling = async (
    key: string,
    producer: ID | null,
  ): Promise<ID> => {
    const { ids } = await products.findOrCreateByMatchKeys([
      {
        factSources: {},
        matchKey: `${TOKEN}-${key}`,
        name: `${key} ${TOKEN} 0.7l`,
        brandOrig: null,
        typeId: null,
        countryId: null,
        age: null,
        abv: null,
        volumeMl: 700,
      },
    ]);

    const id = [...ids.values()][0];

    if (producer !== null) {
      await dataSource.query(
        'UPDATE product SET "producerId" = $1 WHERE id = $2',
        [producer, id],
      );
    }

    return id;
  };

  /**
   * Creates one store's offer of a bottling and gives it a price.
   *
   * @param storeId - The store carrying it.
   * @param productId - The bottling offered.
   * @param price - The offer's current price.
   * @returns The new offer id.
   */
  const makeOffer = async (
    storeId: ID,
    productId: ID,
    price: number,
  ): Promise<ID> => {
    const offer = await offers.upsertFromScrape({
      storeId,
      productId,
      sku: `sku-${productId.slice(0, 8)}-${price}`,
      url: `https://example.test/${price}`,
      nameOrig: `Віскі ${TOKEN} ${price}`,
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

    return offer.id;
  };

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    products = moduleRef.get(CoreProductService, { strict: false });
    offers = moduleRef.get(CoreStoreProductService, { strict: false });
    snapshots = moduleRef.get(CorePriceSnapshotService, { strict: false });
    preferences = moduleRef.get(CorePreferenceService, { strict: false });

    service = new ReportService(offers, snapshots);

    storeA = await makeStore(SLUG_A, 'IT Pref A');
    storeB = await makeStore(SLUG_B, 'IT Pref B');
    userA = await makeUser('a');
    userB = await makeUser('b');

    const seeded = await dataSource.query(
      `INSERT INTO producer (slug, name, kind, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [BRAND_SLUG, BRAND, ProducerKind.DISTILLERY, KbStatus.AUTO],
    ) as { id: ID }[];

    producerId = seeded[0].id;

    const bottlerRows = await dataSource.query(
      `INSERT INTO producer (slug, name, kind, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [BOTTLER_SLUG, BOTTLER, ProducerKind.BOTTLER, KbStatus.AUTO],
    ) as { id: ID }[];

    bottlerId = bottlerRows[0].id;

    brandedId = await makeBottling('branded', producerId);
    siblingId = await makeBottling('sibling', producerId);
    brandlessId = await makeBottling('brandless', null);
    plainId = await makeBottling('plain', null);

    /**
     * The branded bottling is carried by both stores, which is what lets the
     * `best` assertion check that a favorites filter keeps the whole comparison
     * set rather than half of it.
     */
    await makeOffer(storeA, brandedId, 1000);
    await makeOffer(storeB, brandedId, 1200);
    await makeOffer(storeA, siblingId, 1300);
    await makeOffer(storeA, brandlessId, 1400);
    await makeOffer(storeA, plainId, 1500);

    /**
     * An independently bottled whisky: the distillery is unknown, the bottler
     * is not. This is the shape that made the brand rule worth re-testing.
     */
    bottledId = await makeBottling('bottled', null);

    await dataSource.query(
      'UPDATE product SET "bottlerId" = $1 WHERE id = $2',
      [bottlerId, bottledId],
    );

    await makeOffer(storeA, bottledId, 1600);
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
      'DELETE FROM blacklist_producer WHERE "userId" = ANY($1::uuid[])',
      [[userA, userB]],
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      const productIds = [
        brandedId,
        siblingId,
        brandlessId,
        plainId,
        bottledId,
      ];

      await dataSource.query(
        'DELETE FROM store_product WHERE "storeId" = ANY($1::uuid[])',
        [[storeA, storeB]],
      );
      await dataSource.query(
        'DELETE FROM product WHERE id = ANY($1::uuid[])',
        [productIds],
      );
      await dataSource.query(
        'DELETE FROM producer WHERE id = ANY($1::uuid[])',
        [[producerId, bottlerId]],
      );
      await dataSource.query(
        'DELETE FROM store WHERE id = ANY($1::uuid[])',
        [[storeA, storeB]],
      );
      await dataSource.query(
        'DELETE FROM "user" WHERE id = ANY($1::uuid[])',
        [[userA, userB]],
      );

      await closeIntegrationModule(moduleRef);
    }
  });

  it('returns every seeded bottling when nothing is set', async () => {
    const groups = await run(userA);

    expect(idsOf(groups)).toEqual(
      [brandedId, siblingId, brandlessId, plainId, bottledId].sort(),
    );
  });

  it('hides a blacklisted bottling for that user only', async () => {
    await preferences.addToBlacklist(userA, {
      productIds: [brandedId],
      producerIds: [],
    });

    expect(idsOf(await run(userA))).not.toContain(brandedId);
    expect(idsOf(await run(userB))).toContain(brandedId);
  });

  it.each(Object.values(ReportKind))(
    'honours the blacklist on the %s report',
    async (kind) => {
      await preferences.addToBlacklist(userA, {
        productIds: [brandedId],
        producerIds: [],
      });

      const groups = await run(userA, {}, kind);

      expect(idsOf(groups)).not.toContain(brandedId);
    },
  );

  it('hides a blacklisted brand, sparing the brandless', async () => {
    await preferences.addToBlacklist(userA, {
      productIds: [],
      producerIds: [producerId],
    });

    const ids = idsOf(await run(userA));

    expect(ids).not.toContain(brandedId);
    expect(ids).not.toContain(siblingId);

    /**
     * The comparison is UNKNOWN when neither producer slot is filled, so
     * `NOT EXISTS` holds and such a bottling survives: there is no unknown
     * maker to hide.
     */
    expect(ids).toContain(brandlessId);
    expect(ids).toContain(plainId);
  });

  /**
   * The predicate this change was most likely to break. A brand rule used to
   * name a `brand` row, and an independently bottled whisky carried the
   * bottler there — so hiding `Douglas Laing` hid its eighty-one bottlings.
   * Naming a producer instead would have hidden none of them, because the
   * distillery sits in `producerId` and the bottler in `bottlerId`, unless the
   * rule tests both slots. It does.
   */
  it('hides a bottling whose blacklisted maker is its bottler', async () => {
    await preferences.addToBlacklist(userA, {
      productIds: [],
      producerIds: [bottlerId],
    });

    const ids = idsOf(await run(userA));

    expect(ids).not.toContain(bottledId);

    expect(ids).toContain(brandedId);
    expect(ids).toContain(brandlessId);
  });

  it('keeps only the favorites when the filter is on', async () => {
    await preferences.addFavorites(userA, [plainId]);

    const groups = await run(userA, { favoritesOnly: true });

    expect(idsOf(groups)).toEqual([plainId]);
  });

  it('answers empty for a favorites filter with no favorites', async () => {
    const page = await service.report(
      ReportKind.CATALOG,
      { userId: userA, name: TOKEN, favoritesOnly: true },
      OPTIONS,
    );

    expect(page.data).toEqual([]);
    expect(page.total).toBe(0);
  });

  it("leaves a favorited bottling's whole comparison set intact", async () => {
    await preferences.addFavorites(userA, [brandedId]);

    const groups = await run(userA, { favoritesOnly: true }, ReportKind.BEST);

    /**
     * The predicate filters the bottling, not the offer, so both stores' offers
     * still reach `best` — the two-store guard and the saving it quotes are
     * unaffected.
     */
    expect(groups).toHaveLength(1);
    expect(groups[0].productId).toBe(brandedId);
    expect(groups[0].offers).toHaveLength(2);
  });

  it('keeps single-item paths reachable for a hidden bottling', async () => {
    const offerId = await makeOffer(storeA, brandedId, 1000);

    await preferences.addToBlacklist(userA, {
      productIds: [brandedId],
      producerIds: [],
    });

    /**
     * Deliberate: the product card that just hid a bottling must keep working,
     * and un-hiding it is API-only for now, so its history has to stay
     * inspectable.
     */
    const row = await offers.findCurrentRowById(offerId);

    expect(row?.productId).toBe(brandedId);
    expect(await offers.resolveIdByTerm(TOKEN)).not.toBeNull();
  });
});
