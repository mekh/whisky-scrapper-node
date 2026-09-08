import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import {
  CoreUserCollectionPurchaseService,
  CoreUserCollectionService,
} from '~core/user-collection';
import { CollectionTimelineGranularity } from '~enums';
import { DuplicateError, NotFoundError } from '~errors';
import type { ID } from '~types';

import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

const STAMP = Date.now();

/**
 * Prefixes every throwaway row this suite creates, so cleanup and manual
 * inspection can both tell them apart from the shared development data.
 */
const TOKEN = `itcol${STAMP}`;

/**
 * A throwaway currency, so the suite never touches the real UAH/USD/EUR rows
 * or the rate history the application depends on — the pattern
 * `currency-rate.integration.spec.ts` established. Its rates are chosen to
 * *reorder* the collection's purchases (see the conversion test), because a
 * rate that preserved the hryvnia ranking would prove nothing about which
 * amount the extremes are ranked by.
 */
const CURRENCY_CODE = 'TST';

const STORE_KNOWN_SLUG = `__it_col_a_${STAMP}`;

const STORE_KNOWN_NAME = 'IT Collection Store';

/**
 * The `user_collection`/`user_collection_purchase` persistence layer, plus
 * the `store_product` read the (not yet built) domain layer will assemble a
 * collection item's `offers` from — `CoreStoreProductService
 * .findCurrentRowsByProductIds` is documented as exactly that read, so this
 * suite exercises it directly rather than through an HTTP layer that does
 * not exist yet.
 *
 * Two real catalogue rows anchor the country/region breakdowns in real data
 * (picked by SQL, never hardcoded ids) and two throwaway products cover the
 * cases no real row can safely stand in for: a bottling with no offers at
 * all, and one whose only two offers must have known, exact prices.
 */
describe('personal collection (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let products: CoreProductService;
  let storeProducts: CoreStoreProductService;
  let collections: CoreUserCollectionService;
  let purchases: CoreUserCollectionPurchaseService;

  let userA: ID;
  let userB: ID;
  let userStats: ID;
  let userFx: ID;
  let storeKnownId: ID;
  let currencyId: ID;
  let fxRowId: ID;
  let fxPurchasePriced: ID;

  let scotchMain: {
    id: ID;
    name: string;
    age: number | null;
    abv: number | null;
    volumeMl: number | null;
    distillery: string | null;
    bottler: string | null;
    region: string | null;
    type: string | null;
    countryCode: string;
    countryName: string;
    countryIcon: string | null;
    flavors: string[];
    nameOrig: string | null;
  };

  let scotchAlt: { id: ID; region: string | null };
  let scotchUnresolved: { id: ID };
  let nonScotch: { id: ID; countryCode: string };

  let offersProductId: ID;
  let noOfferProductId: ID;
  let cheapOfferId: ID;
  let expensiveOfferId: ID;

  let mainCollectionId: ID;
  let noOfferCollectionId: ID;

  let statsRowA: ID;
  let statsRowB: ID;
  let statsRowUnresolved: ID;
  let statsPurchaseB: ID;
  let statsPurchaseC: ID;

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
      [`itcol${STAMP}${suffix}`.slice(0, 32)],
    ) as { id: ID }[];

    return rows[0].id;
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
   * Finds a real, well-populated Scotch bottling to anchor the bottling-facts
   * assertions in real data: a resolved distillery and region, every
   * headline fact filled in, at least one flavour tag, and exactly one store
   * listing it so its `nameOrig` is unambiguous.
   *
   * Every field is read directly off `product`/`producer`/`country`/`type`/
   * `flavor`/`store_product` — independently of `UserCollectionRepository`,
   * so comparing its answer against this one is not tautological.
   *
   * @returns The bottling's facts, as the suite expects to read them back.
   */
  const fetchWellPopulatedScotch = async (): Promise<typeof scotchMain> => {
    const rows = await dataSource.query(`
      SELECT p.id, p.name, p.age, p.abv::float8 AS abv, p."volumeMl",
             pr.name AS distillery, bo.name AS bottler, pr.region,
             t.name AS type, c.code AS "countryCode",
             c."nameUa" AS "countryName", c.icon AS "countryIcon"
      FROM product p
      JOIN country c ON c.id = p."countryId"
      JOIN producer pr ON pr.id = p."producerId"
      JOIN type t ON t.id = p."typeId"
      LEFT JOIN producer bo ON bo.id = p."bottlerId"
      WHERE c.code = 'GB-SCT' AND pr.region IS NOT NULL
        AND p.age IS NOT NULL AND p.abv IS NOT NULL
        AND p."volumeMl" IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM product_flavor pf WHERE pf."productId" = p.id
        )
        AND (
          SELECT count(*) FROM store_product sp
          WHERE sp."productId" = p.id
        ) = 1
      ORDER BY p.id
      LIMIT 1
    `) as {
      id: ID;
      name: string;
      age: number;
      abv: number;
      volumeMl: number;
      distillery: string;
      bottler: string | null;
      region: string;
      type: string;
      countryCode: string;
      countryName: string;
      countryIcon: string | null;
    }[];

    const [row] = rows;

    if (!row) {
      throw new Error('No well-populated single-offer Scotch bottling found');
    }

    const flavorRows = await dataSource.query(
      `SELECT f.name FROM product_flavor pf
       JOIN flavor f ON f.id = pf."flavorId"
       WHERE pf."productId" = $1
       ORDER BY f.name`,
      [row.id],
    ) as { name: string }[];

    const offerRows = await dataSource.query(
      'SELECT "nameOrig" FROM store_product WHERE "productId" = $1',
      [row.id],
    ) as { nameOrig: string }[];

    return {
      ...row,
      flavors: flavorRows.map((flavor) => flavor.name),
      nameOrig: offerRows[0]?.nameOrig ?? null,
    };
  };

  /**
   * Finds a second real Scotch bottling with a resolved region different
   * from `exclude`'s, so the region breakdown has two distinct real buckets
   * to assert on rather than one bucket counted twice.
   *
   * @param excludeId - The bottling already picked; never returned again.
   * @param excludeRegion - Its region; the result's region must differ.
   * @returns The second bottling's id and region.
   */
  const fetchAltRegionScotch = async (
    excludeId: ID,
    excludeRegion: string | null,
  ): Promise<typeof scotchAlt> => {
    const rows = await dataSource.query(
      `SELECT p.id, pr.region
       FROM product p
       JOIN country c ON c.id = p."countryId"
       JOIN producer pr ON pr.id = p."producerId"
       WHERE c.code = 'GB-SCT' AND pr.region IS NOT NULL AND p.id <> $1
       ORDER BY p.id
       LIMIT 30`,
      [excludeId],
    ) as { id: ID; region: string }[];

    const found = rows.find((row) => row.region !== excludeRegion) ?? rows[0];

    if (!found) {
      throw new Error('No second real Scotch bottling found');
    }

    return found;
  };

  /**
   * Finds a real Scotch bottling whose distillery never resolved — the
   * `unknown` case of the region breakdown.
   *
   * @returns The bottling's id.
   */
  const fetchUnresolvedScotch = async (): Promise<typeof scotchUnresolved> => {
    const rows = await dataSource.query(`
      SELECT p.id
      FROM product p
      JOIN country c ON c.id = p."countryId"
      WHERE c.code = 'GB-SCT' AND p."producerId" IS NULL
      ORDER BY p.id
      LIMIT 1
    `) as { id: ID }[];

    const [row] = rows;

    if (!row) {
      throw new Error('No unresolved-distillery Scotch bottling found');
    }

    return row;
  };

  /**
   * Finds a real bottling from outside Scotland, for the "absent entirely
   * from the region breakdown" case.
   *
   * @returns The bottling's id and country code.
   */
  const fetchNonScotch = async (): Promise<typeof nonScotch> => {
    const rows = await dataSource.query(`
      SELECT p.id, c.code AS "countryCode"
      FROM product p
      JOIN country c ON c.id = p."countryId"
      WHERE c.code <> 'GB-SCT'
      ORDER BY p.id
      LIMIT 1
    `) as { id: ID; countryCode: string }[];

    const [row] = rows;

    if (!row) {
      throw new Error('No non-Scotch bottling found');
    }

    return row;
  };

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    products = moduleRef.get(CoreProductService, { strict: false });
    storeProducts = moduleRef.get(CoreStoreProductService, {
      strict: false,
    });
    collections = moduleRef.get(CoreUserCollectionService);
    purchases = moduleRef.get(CoreUserCollectionPurchaseService);

    userA = await makeUser('a');
    userB = await makeUser('b');
    userStats = await makeUser('stats');
    storeKnownId = await makeStore(STORE_KNOWN_SLUG, STORE_KNOWN_NAME);

    scotchMain = await fetchWellPopulatedScotch();
    scotchAlt = await fetchAltRegionScotch(scotchMain.id, scotchMain.region);
    scotchUnresolved = await fetchUnresolvedScotch();
    nonScotch = await fetchNonScotch();

    const offersMatchKey = `${TOKEN}-offers`;
    const noOfferMatchKey = `${TOKEN}-nooffer`;

    const created = await products.findOrCreateByMatchKeys([
      {
        matchKey: offersMatchKey,
        name: `Collection Offers ${TOKEN}`,
        brandOrig: null,
        typeId: null,
        countryId: null,
        age: null,
        abv: null,
        volumeMl: null,
        factSources: {},
      },
      {
        matchKey: noOfferMatchKey,
        name: `Collection No Offer ${TOKEN}`,
        brandOrig: null,
        typeId: null,
        countryId: null,
        age: null,
        abv: null,
        volumeMl: null,
        factSources: {},
      },
    ]);

    const foundOffersId = created.ids.get(offersMatchKey);
    const foundNoOfferId = created.ids.get(noOfferMatchKey);

    if (!foundOffersId || !foundNoOfferId) {
      throw new Error('Failed to seed throwaway products for the suite');
    }

    offersProductId = foundOffersId;
    noOfferProductId = foundNoOfferId;

    const cheapRows = await dataSource.query(
      `INSERT INTO store_product
         ("storeId", "productId", sku, url, "nameOrig",
          "firstSeen", "lastSeen")
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, CURRENT_DATE)
       RETURNING id`,
      [
        storeKnownId,
        offersProductId,
        `${TOKEN}-off-cheap`,
        'https://example.test/collection-offer-cheap',
        `Collection Offer Cheap ${TOKEN}`,
      ],
    ) as { id: ID }[];

    cheapOfferId = cheapRows[0].id;

    const expensiveRows = await dataSource.query(
      `INSERT INTO store_product
         ("storeId", "productId", sku, url, "nameOrig",
          "firstSeen", "lastSeen")
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, CURRENT_DATE)
       RETURNING id`,
      [
        storeKnownId,
        offersProductId,
        `${TOKEN}-off-expensive`,
        'https://example.test/collection-offer-expensive',
        `Collection Offer Expensive ${TOKEN}`,
      ],
    ) as { id: ID }[];

    expensiveOfferId = expensiveRows[0].id;

    await dataSource.query(
      `INSERT INTO price_snapshot
         ("storeProductId", price, "oldPrice", currency, "inStock", promo)
       VALUES ($1, 500, NULL, 'UAH', true, false)`,
      [cheapOfferId],
    );
    await dataSource.query(
      `INSERT INTO price_snapshot
         ("storeProductId", price, "oldPrice", currency, "inStock", promo)
       VALUES ($1, 900, NULL, 'UAH', true, false)`,
      [expensiveOfferId],
    );

    statsRowA = await collections.createForUser(userStats, scotchMain.id, {});
    statsRowB = await collections.createForUser(userStats, scotchAlt.id, {});
    statsRowUnresolved = await collections.createForUser(
      userStats,
      scotchUnresolved.id,
      {},
    );

    await collections.createForUser(userStats, nonScotch.id, {});

    await purchases.createForCollection(statsRowA, {
      price: 1000,
      purchasedOn: '2024-01-15',
      storeId: storeKnownId,
    });

    statsPurchaseB = await purchases.createForCollection(statsRowB, {
      price: 3000,
      purchasedOn: '2024-03-10',
      storeName: 'Duty Free',
    });

    statsPurchaseC = await purchases.createForCollection(statsRowUnresolved, {
      price: 500,
      purchasedOn: '2024-01-20',
    });

    const currencyRows = await dataSource.query(
      `INSERT INTO currency
         (code, "numericCode", "nameUa", symbol, "isBase", active)
       VALUES ($1, 999, 'Тестова', 'T', false, true)
       RETURNING id`,
      [CURRENCY_CODE],
    ) as { id: ID }[];

    currencyId = currencyRows[0].id;

    await dataSource.query(
      `INSERT INTO currency_rate ("currencyId", rate, "effectiveOn")
       VALUES ($1, 10, '2024-01-01'), ($1, 100, '2024-03-10')`,
      [currencyId],
    );

    userFx = await makeUser('fx');
    fxRowId = await collections.createForUser(userFx, scotchMain.id, {});

    await purchases.createForCollection(fxRowId, {
      price: 700,
      purchasedOn: '2023-06-01',
    });

    fxPurchasePriced = await purchases.createForCollection(fxRowId, {
      price: 1000,
      purchasedOn: '2024-01-15',
    });
  });

  afterAll(async () => {
    await dataSource.query('DELETE FROM "user" WHERE id = ANY($1::uuid[])', [
      [userA, userB, userStats, userFx],
    ]);
    await dataSource.query('DELETE FROM currency WHERE code = $1', [
      CURRENCY_CODE,
    ]);
    await dataSource.query('DELETE FROM store WHERE id = $1', [
      storeKnownId,
    ]);
    await dataSource.query('DELETE FROM product WHERE id = ANY($1::uuid[])', [
      [offersProductId, noOfferProductId],
    ]);

    await closeIntegrationModule(moduleRef);
  });

  it(
    "reads back a whisky's bottling facts after adding it to the "
      + 'collection',
    async () => {
      mainCollectionId = await collections.createForUser(
        userA,
        scotchMain.id,
        {
          rating: 8.5,
          barcode: '1234567890123',
          notes: 'Great one',
          nose: 'vanilla, honey',
          palate: 'oak, spice',
          finish: 'long, warm',
        },
      );

      const row = await collections.findByIdForUser(mainCollectionId, userA);

      if (!row) {
        throw new Error('Newly created collection row did not read back');
      }

      expect(row.productId).toBe(scotchMain.id);
      expect(row.rating).toBe(8.5);
      expect(typeof row.rating).toBe('number');
      expect(row.barcode).toBe('1234567890123');
      expect(row.notes).toBe('Great one');
      expect(row.nose).toBe('vanilla, honey');
      expect(row.palate).toBe('oak, spice');
      expect(row.finish).toBe('long, warm');

      expect(row.name).toBe(scotchMain.name);
      expect(row.nameOrig).toBe(scotchMain.nameOrig);
      expect(row.age).toBe(scotchMain.age);
      expect(typeof row.age).toBe('number');
      expect(row.abv).toBe(scotchMain.abv);
      expect(typeof row.abv).toBe('number');
      expect(row.volumeMl).toBe(scotchMain.volumeMl);
      expect(row.brand).toBe(scotchMain.distillery);
      expect(row.distillery).toBe(scotchMain.distillery);
      expect(row.bottler).toBe(scotchMain.bottler);
      expect(row.type).toBe(scotchMain.type);
      expect(row.countryCode).toBe(scotchMain.countryCode);
      expect(row.countryName).toBe(scotchMain.countryName);
      expect(row.countryIcon).toBe(scotchMain.countryIcon);
      expect(row.region).toBe(scotchMain.region);
      expect(row.flavors).toEqual(scotchMain.flavors);
    },
  );

  it(
    "returns a bottling's offers cheapest-first and excludes an "
      + 'out-of-stock one',
    async () => {
      const rows = await storeProducts.findCurrentRowsByProductIds([
        offersProductId,
      ]);

      expect(rows).toHaveLength(2);

      /**
       * `findCurrentRowsByProductIds` is documented to return its rows
       * unordered — sorting is the caller's job, which the future domain
       * assembly step (and this assertion, standing in for it) performs.
       */
      const sorted = [...rows].sort((a, b) => a.price - b.price);

      expect(sorted.map((row) => row.price)).toEqual([500, 900]);
      expect(typeof sorted[0].price).toBe('number');
      expect(sorted[0].id).toBe(cheapOfferId);
      expect(sorted[1].id).toBe(expensiveOfferId);

      await dataSource.query(
        'UPDATE store_product SET "inStock" = false WHERE id = $1',
        [expensiveOfferId],
      );

      const afterFlip = await storeProducts.findCurrentRowsByProductIds([
        offersProductId,
      ]);

      expect(afterFlip).toHaveLength(1);
      expect(afterFlip[0].id).toBe(cheapOfferId);
      expect(afterFlip[0].price).toBe(500);
    },
  );

  it(
    'reads back a bottling no shop lists, with an empty offers list',
    async () => {
      noOfferCollectionId = await collections.createForUser(
        userA,
        noOfferProductId,
        {},
      );

      const row = await collections.findByIdForUser(
        noOfferCollectionId,
        userA,
      );

      if (!row) {
        throw new Error('Newly created collection row did not read back');
      }

      expect(row.productId).toBe(noOfferProductId);
      expect(row.name).toBe(`Collection No Offer ${TOKEN}`);
      expect(row.nameOrig).toBeNull();
      expect(row.age).toBeNull();
      expect(row.abv).toBeNull();
      expect(row.volumeMl).toBeNull();
      expect(row.brand).toBeNull();
      expect(row.distillery).toBeNull();
      expect(row.bottler).toBeNull();
      expect(row.type).toBeNull();
      expect(row.countryCode).toBeNull();
      expect(row.region).toBeNull();
      expect(row.flavors).toEqual([]);

      const offers = await storeProducts.findCurrentRowsByProductIds([
        noOfferProductId,
      ]);

      expect(offers).toEqual([]);
    },
  );

  it(
    'rejects adding the same bottling twice for one user, but lets '
      + 'another user hold it',
    async () => {
      await expect(
        collections.createForUser(userA, scotchMain.id, {}),
      ).rejects.toBeInstanceOf(DuplicateError);

      const otherUserCollectionId = await collections.createForUser(
        userB,
        scotchMain.id,
        {},
      );

      const rowB = await collections.findByIdForUser(
        otherUserCollectionId,
        userB,
      );

      expect(rowB).not.toBeNull();
      expect(rowB?.productId).toBe(scotchMain.id);
    },
  );

  it(
    "hides another user's row behind a null read and a NotFoundError "
      + 'on write',
    async () => {
      const foreignRead = await collections.findByIdForUser(
        mainCollectionId,
        userB,
      );

      expect(foreignRead).toBeNull();

      await expect(
        collections.updateForUser(userB, mainCollectionId, { rating: 1 }),
      ).rejects.toBeInstanceOf(NotFoundError);

      await expect(
        collections.deleteForUser(userB, mainCollectionId),
      ).rejects.toBeInstanceOf(NotFoundError);

      const stillA = await collections.findByIdForUser(
        mainCollectionId,
        userA,
      );

      expect(stillA).not.toBeNull();
      expect(stillA?.rating).toBe(8.5);
    },
  );

  it(
    'reads several purchases oldest-first and rejects a purchase naming '
      + 'both a store and a free-text shop',
    async () => {
      const purchaseMay = await purchases.createForCollection(
        mainCollectionId,
        { price: 1200, purchasedOn: '2024-05-01', storeId: storeKnownId },
      );
      const purchaseApril = await purchases.createForCollection(
        mainCollectionId,
        { price: 1300, purchasedOn: '2024-04-01', storeName: 'Kyiv Duty Free' },
      );
      const purchaseJune = await purchases.createForCollection(
        mainCollectionId,
        { price: 1100, purchasedOn: '2024-06-01' },
      );

      const list = await purchases.findByCollectionIds([mainCollectionId]);

      expect(list.map((row) => row.id)).toEqual([
        purchaseApril,
        purchaseMay,
        purchaseJune,
      ]);

      const april = list.find((row) => row.id === purchaseApril);
      const may = list.find((row) => row.id === purchaseMay);

      expect(april?.storeSlug).toBeNull();
      expect(april?.storeName).toBe('Kyiv Duty Free');
      expect(may?.storeSlug).toBe(STORE_KNOWN_SLUG);
      expect(may?.storeName).toBeNull();

      await expect(
        dataSource.query(
          `INSERT INTO user_collection_purchase
             ("collectionId", "storeId", "storeName")
           VALUES ($1, $2, $3)`,
          [mainCollectionId, storeKnownId, 'Both named'],
        ),
      ).rejects.toThrow(/user_collection_purchase_store_check/);
    },
  );

  it(
    'rejects an out-of-range rating and a non-numeric barcode at the '
      + 'database level',
    async () => {
      await expect(
        dataSource.query(
          `INSERT INTO user_collection ("userId", "productId", rating)
           VALUES ($1, $2, 10.5)`,
          [userA, scotchAlt.id],
        ),
      ).rejects.toThrow(/user_collection_rating_check/);

      await expect(
        dataSource.query(
          `INSERT INTO user_collection ("userId", "productId", rating)
           VALUES ($1, $2, -1)`,
          [userA, scotchAlt.id],
        ),
      ).rejects.toThrow(/user_collection_rating_check/);

      await expect(
        dataSource.query(
          `INSERT INTO user_collection ("userId", "productId", barcode)
           VALUES ($1, $2, 'abcdefgh')`,
          [userA, scotchAlt.id],
        ),
      ).rejects.toThrow(/user_collection_barcode_check/);
    },
  );

  it(
    "answers an empty purchase patch from the purchase's own row",
    async () => {
      const purchaseId = await purchases.createForCollection(
        mainCollectionId,
        { price: 500 },
      );

      /**
       * The regression this pins. An empty patch writes nothing — TypeORM
       * rejects an `UPDATE` with no columns to set — and the repository used
       * to answer `true` for it without looking, so a `purchases.update`
       * entry naming only an id reported success for *any* purchase id,
       * including one from another shelf. The contract promises a `404`
       * there, and a client reading `200` learns the id exists.
       */
      await expect(
        purchases.updateForCollection(mainCollectionId, purchaseId, {}),
      ).resolves.toBeUndefined();

      await expect(
        purchases.updateForCollection(noOfferCollectionId, purchaseId, {}),
      ).rejects.toThrow(/Purchase not found/);

      await expect(
        purchases.updateForCollection(mainCollectionId, mainCollectionId, {}),
      ).rejects.toThrow(/Purchase not found/);

      await purchases.deleteForCollection(mainCollectionId, purchaseId);
    },
  );

  it(
    'cascades a collection delete to its purchases, a user delete to '
      + "their collection rows, and nulls a purchase's store when the "
      + 'store is deleted',
    async () => {
      const cascadeUser = await makeUser('cascade');

      const rowId = await collections.createForUser(
        cascadeUser,
        scotchUnresolved.id,
        {},
      );

      const purchaseId = await purchases.createForCollection(rowId, {
        price: 100,
      });

      await dataSource.query('DELETE FROM user_collection WHERE id = $1', [
        rowId,
      ]);

      const purchaseRows = await dataSource.query(
        'SELECT count(*)::int AS count FROM user_collection_purchase '
          + 'WHERE id = $1',
        [purchaseId],
      ) as { count: number }[];

      expect(purchaseRows[0].count).toBe(0);

      const otherRowId = await collections.createForUser(
        cascadeUser,
        nonScotch.id,
        {},
      );

      await dataSource.query('DELETE FROM "user" WHERE id = $1', [
        cascadeUser,
      ]);

      const collectionRows = await dataSource.query(
        'SELECT count(*)::int AS count FROM user_collection WHERE id = $1',
        [otherRowId],
      ) as { count: number }[];

      expect(collectionRows[0].count).toBe(0);

      const cascadeUser2 = await makeUser('cascade2');
      const tempStoreId = await makeStore(
        `__it_col_tmp_${STAMP}`,
        'IT Collection Temp Store',
      );

      const rowForStoreTest = await collections.createForUser(
        cascadeUser2,
        scotchAlt.id,
        {},
      );

      const purchaseWithStoreId = await purchases.createForCollection(
        rowForStoreTest,
        { price: 50, storeId: tempStoreId },
      );

      await dataSource.query('DELETE FROM store WHERE id = $1', [
        tempStoreId,
      ]);

      const afterStoreDelete = await purchases.findByCollectionIds([
        rowForStoreTest,
      ]);

      expect(afterStoreDelete).toHaveLength(1);
      expect(afterStoreDelete[0].id).toBe(purchaseWithStoreId);
      expect(afterStoreDelete[0].storeSlug).toBeNull();

      await dataSource.query('DELETE FROM "user" WHERE id = $1', [
        cascadeUser2,
      ]);
    },
  );

  it(
    "refuses to delete a bottling that still sits in someone's "
      + 'collection',
    async () => {
      await expect(
        dataSource.query('DELETE FROM product WHERE id = $1', [
          noOfferProductId,
        ]),
      ).rejects.toThrow(/fk_user_collection_product/);
    },
  );

  it(
    'computes summary, extremes, and country/region/store breakdowns '
      + 'over a known collection',
    async () => {
      const summary = await purchases.summaryForUser(userStats);

      expect(summary.items).toBe(4);
      expect(summary.bottles).toBe(3);
      expect(summary.pricedBottles).toBe(3);
      expect(summary.totalSpent).toBe(4500);
      expect(typeof summary.totalSpent).toBe('number');
      expect(summary.avgPrice).toBe(1500);
      expect(typeof summary.avgPrice).toBe('number');

      const mostExpensive = await purchases.mostExpensiveForUser(userStats);

      expect(mostExpensive?.purchaseId).toBe(statsPurchaseB);
      expect(mostExpensive?.collectionId).toBe(statsRowB);
      expect(mostExpensive?.price).toBe(3000);
      expect(typeof mostExpensive?.price).toBe('number');
      expect(mostExpensive?.store).toBeNull();
      expect(mostExpensive?.storeName).toBe('Duty Free');

      const cheapest = await purchases.cheapestForUser(userStats);

      expect(cheapest?.purchaseId).toBe(statsPurchaseC);
      expect(cheapest?.collectionId).toBe(statsRowUnresolved);
      expect(cheapest?.price).toBe(500);
      expect(cheapest?.store).toBeNull();
      expect(cheapest?.storeName).toBeNull();

      const byCountry = await purchases.countByCountryForUser(userStats);
      const scotBucket = byCountry.find(
        (bucket) => bucket.countryCode === 'GB-SCT',
      );
      const nonScotBucket = byCountry.find(
        (bucket) => bucket.countryCode === nonScotch.countryCode,
      );

      expect(byCountry).toHaveLength(2);
      expect(scotBucket?.bottles).toBe(3);
      expect(scotBucket?.items).toBe(3);
      expect(nonScotBucket?.bottles).toBe(0);
      expect(nonScotBucket?.items).toBe(1);

      const byRegion = await purchases.countByRegionForUser(userStats);

      expect(byRegion).toHaveLength(3);

      const regionMain = byRegion.find(
        (bucket) => bucket.region === scotchMain.region,
      );
      const regionAlt = byRegion.find(
        (bucket) => bucket.region === scotchAlt.region,
      );
      const regionUnknown = byRegion.find(
        (bucket) => bucket.region === 'unknown',
      );

      expect(regionMain?.bottles).toBe(1);
      expect(regionMain?.items).toBe(1);
      expect(regionAlt?.bottles).toBe(1);
      expect(regionUnknown?.bottles).toBe(1);
      expect(
        byRegion.some((bucket) => bucket.region === nonScotch.countryCode),
      ).toBe(false);

      const byStore = await purchases.countByStoreForUser(userStats);
      const knownBucket = byStore.find(
        (bucket) => bucket.slug === STORE_KNOWN_SLUG,
      );
      const freeTextBucket = byStore.find(
        (bucket) => bucket.name === 'Duty Free',
      );

      expect(byStore).toHaveLength(2);
      expect(knownBucket?.name).toBe(STORE_KNOWN_NAME);
      expect(knownBucket?.bottles).toBe(1);
      expect(knownBucket?.spent).toBe(1000);
      expect(freeTextBucket?.slug).toBeNull();
      expect(freeTextBucket?.bottles).toBe(1);
      expect(freeTextBucket?.spent).toBe(3000);
    },
  );

  it(
    'builds a dense month-by-month timeline and collapses it to years',
    async () => {
      const monthly = await purchases.timelineForUser(
        userStats,
        '2024-01',
        '2024-03',
        CollectionTimelineGranularity.MONTH,
      );

      expect(monthly.map((bucket) => bucket.period)).toEqual([
        '2024-01',
        '2024-02',
        '2024-03',
      ]);
      expect(monthly[0].bottles).toBe(2);
      expect(monthly[0].spent).toBe(1500);
      expect(monthly[1].bottles).toBe(0);
      expect(monthly[1].spent).toBe(0);
      expect(monthly[2].bottles).toBe(1);
      expect(monthly[2].spent).toBe(3000);

      const yearly = await purchases.timelineForUser(
        userStats,
        '2024-01',
        '2024-12',
        CollectionTimelineGranularity.YEAR,
      );

      expect(yearly.map((bucket) => bucket.period)).toEqual(['2024']);
      expect(yearly[0].bottles).toBe(3);
      expect(yearly[0].spent).toBe(4500);
    },
  );

  it(
    'returns the first and last purchase months, or null with no '
      + 'purchases',
    async () => {
      const bounds = await purchases.boundsForUser(userStats);

      expect(bounds).toEqual({ firstMonth: '2024-01', lastMonth: '2024-03' });

      const emptyBounds = await purchases.boundsForUser(userB);

      expect(emptyBounds).toBeNull();
    },
  );
  it(
    "states every money aggregate at each purchase's own day rate",
    async () => {
      const summary = await purchases.summaryForUser(userStats, currencyId);

      /**
       * 1000 on 2024-01-15 and 500 on 2024-01-20 both fall back to the
       * 2024-01-01 rate of 10 (the series holds nothing on those exact
       * days, which is the documented fallback), while 3000 on 2024-03-10
       * hits that day's own rate of 100.
       */
      expect(summary.bottles).toBe(3);
      expect(summary.pricedBottles).toBe(3);
      expect(summary.totalSpent).toBe(180);
      expect(summary.avgPrice).toBe(60);

      const mostExpensive = await purchases.mostExpensiveForUser(
        userStats,
        currencyId,
      );

      /**
       * In hryvnia the dearest bottle is the 3000 one; converted at its own
       * day's rate it is the cheapest of the three. The extremes therefore
       * have to be ranked by the converted amount, not merely restated in
       * the new currency.
       */
      expect(mostExpensive?.collectionId).toBe(statsRowA);
      expect(mostExpensive?.price).toBe(100);

      const cheapest = await purchases.cheapestForUser(userStats, currencyId);

      expect(cheapest?.purchaseId).toBe(statsPurchaseB);
      expect(cheapest?.price).toBe(30);

      const byStore = await purchases.countByStoreForUser(
        userStats,
        currencyId,
      );
      const knownBucket = byStore.find(
        (bucket) => bucket.slug === STORE_KNOWN_SLUG,
      );
      const freeTextBucket = byStore.find(
        (bucket) => bucket.name === 'Duty Free',
      );

      expect(knownBucket?.spent).toBe(100);
      expect(freeTextBucket?.spent).toBe(30);

      const monthly = await purchases.timelineForUser(
        userStats,
        '2024-01',
        '2024-03',
        CollectionTimelineGranularity.MONTH,
        currencyId,
      );

      expect(monthly[0].spent).toBe(150);
      expect(monthly[1].spent).toBe(0);
      expect(monthly[2].spent).toBe(30);

      const yearly = await purchases.timelineForUser(
        userStats,
        '2024-01',
        '2024-12',
        CollectionTimelineGranularity.YEAR,
        currencyId,
      );

      expect(yearly[0].spent).toBe(180);
    },
  );

  it(
    'leaves a purchase older than the currency out of every money field',
    async () => {
      const inHryvnia = await purchases.summaryForUser(userFx);

      expect(inHryvnia.pricedBottles).toBe(2);
      expect(inHryvnia.totalSpent).toBe(1700);

      const converted = await purchases.summaryForUser(userFx, currencyId);

      /**
       * The 2023 bottle predates the currency's first stored rate, so there
       * is no official rate to state it at. It is dropped from the sums and
       * from the divisor alike, rather than being converted at the earliest
       * rate that happens to exist.
       */
      expect(converted.bottles).toBe(2);
      expect(converted.pricedBottles).toBe(1);
      expect(converted.totalSpent).toBe(100);
      expect(converted.avgPrice).toBe(100);

      const cheapest = await purchases.cheapestForUser(userFx, currencyId);

      expect(cheapest?.purchaseId).toBe(fxPurchasePriced);
      expect(cheapest?.price).toBe(100);
    },
  );
});
