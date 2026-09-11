import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CorePriceSnapshotService } from '~core/price-snapshot';
import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import type { ID, ReportCurrentRow } from '~types';

import { clearCatalogue, withRolledBackFixture } from './database-fixture';
import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

const STAMP = Date.now();

const SLUG = `__it_eqv_${STAMP}`;

const TOKEN = `iteqv${STAMP}`;

/**
 * The window-function form `CURRENT_SQL` replaced, kept here verbatim as the
 * reference implementation the rewrite is judged against. It is deliberately
 * a copy rather than an import: the point of the suite is that the new SQL
 * answers what the old one answered, which nothing can check once the old
 * text is gone.
 */
const LEGACY_CURRENT_SQL = `
  WITH ranked AS (
    SELECT s."storeProductId",
           s.price, s."oldPrice", s.currency, s.promo,
           s."createdAt"::date AS captured,
           ROW_NUMBER() OVER w AS rn,
           LEAD(s.price) OVER w AS prev
    FROM price_snapshot s
    WINDOW w AS (PARTITION BY s."storeProductId" ORDER BY s."createdAt" DESC)
  )
  SELECT sp.id,
         r.price::float8 AS price,
         r."oldPrice"::float8 AS "oldPrice",
         r.currency, r.promo,
         r.prev::float8 AS "previousPrice",
         r.captured::text AS "capturedDate"
  FROM ranked r
  JOIN store_product sp ON sp.id = r."storeProductId"
  WHERE r.rn = 1
`;

/**
 * The three whole-table passes `currentPriceSince` replaced.
 */
const LEGACY_PRICE_SINCE_SQL = `
  WITH latest AS (
    SELECT DISTINCT ON ("storeProductId")
           "storeProductId", price AS "currentPrice"
    FROM price_snapshot
    ORDER BY "storeProductId", "createdAt" DESC
  ),
  last_higher AS (
    SELECT s."storeProductId", MAX(s."createdAt") AS "higherAt"
    FROM price_snapshot s
    JOIN latest l ON l."storeProductId" = s."storeProductId"
    WHERE s.price > l."currentPrice"
    GROUP BY s."storeProductId"
  )
  SELECT s."storeProductId", MIN(s."createdAt")::date::text AS since
  FROM price_snapshot s
  LEFT JOIN last_higher h ON h."storeProductId" = s."storeProductId"
  WHERE h."higherAt" IS NULL OR s."createdAt" > h."higherAt"
  GROUP BY s."storeProductId"
`;

/**
 * One offer's snapshot-derived fields, which is all the rewrite changed.
 */
interface SnapshotFields {
  id: ID;
  price: number;
  oldPrice: number | null;
  currency: string;
  promo: boolean;
  previousPrice: number | null;
  capturedDate: string;
}

/**
 * Projects a current row onto the fields the two SQL forms both produce.
 *
 * @param row - A row from either implementation.
 * @returns Its snapshot-derived fields.
 */
function snapshotFields(row: ReportCurrentRow): SnapshotFields {
  return {
    id: row.id,
    price: row.price,
    oldPrice: row.oldPrice ?? null,
    currency: row.currency,
    promo: row.promo,
    previousPrice: row.previousPrice ?? null,
    capturedDate: row.capturedDate,
  };
}

/**
 * Orders rows by offer id so two implementations can be compared directly.
 *
 * @param rows - The rows to order.
 * @returns The same rows, ascending by id.
 */
function byId<T extends { id: ID }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.id.localeCompare(b.id));
}

describe('current-rows SQL equivalence (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let offers: CoreStoreProductService;
  let snapshots: CorePriceSnapshotService;
  let products: CoreProductService;

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);
    offers = moduleRef.get(CoreStoreProductService, { strict: false });
    snapshots = moduleRef.get(CorePriceSnapshotService, { strict: false });
    products = moduleRef.get(CoreProductService, { strict: false });
  });

  afterAll(async () => {
    await closeIntegrationModule(moduleRef);
  });

  /**
   * Whatever the development database already holds, read-only.
   *
   * This is the half that carries the weight while that database is a copy of
   * production: it compares the two forms over the real price history —
   * hundreds of thousands of snapshots and every shape of series in it — which
   * no hand-written fixture can stand in for. On an empty database it proves
   * nothing and says so rather than passing quietly.
   */
  describe('against the ambient catalogue', () => {
    let legacyRows: SnapshotFields[];

    let currentRows: SnapshotFields[];

    let legacySince: Map<ID, string>;

    let currentSince: Map<ID, string>;

    let legacyLatest: string | null;

    let currentLatest: string | null;

    beforeAll(async () => {
      const legacy = await dataSource.query(
        `${LEGACY_CURRENT_SQL} AND sp."inStock"`,
      ) as ReportCurrentRow[];

      const rewritten = await offers.findCurrentRows({});

      legacyRows = byId(legacy.map(snapshotFields));
      currentRows = byId(rewritten.map(snapshotFields));

      const sinceRows = await dataSource.query(
        LEGACY_PRICE_SINCE_SQL,
      ) as { storeProductId: ID; since: string }[];

      legacySince = new Map(
        sinceRows.map((row) => [row.storeProductId, row.since]),
      );

      currentSince = await snapshots.currentPriceSince();

      const latestRows = await dataSource.query(
        'SELECT MAX("createdAt"::date)::text AS d FROM price_snapshot',
      ) as { d: string | null }[];

      legacyLatest = latestRows[0]?.d ?? null;
      currentLatest = await snapshots.latestDate();
    });

    it('reads the same offers with the same prices', () => {
      expect(currentRows).toEqual(legacyRows);
    });

    it('reads the same previous price for every offer', () => {
      const legacyPrev = legacyRows
        .filter((row) => row.previousPrice === null)
        .map((row) => row.id);

      const currentPrev = currentRows
        .filter((row) => row.previousPrice === null)
        .map((row) => row.id);

      expect(currentPrev).toEqual(legacyPrev);
    });

    it('dates the current price level the same way', () => {
      expect([...currentSince.entries()].sort())
        .toEqual([...legacySince.entries()].sort());
    });

    it('reports the same latest capture date', () => {
      expect(currentLatest).toEqual(legacyLatest);
    });

    it('had a catalogue to compare over', () => {
      /**
       * A guard on the four assertions above, not a fact about the product:
       * every one of them passes vacuously on an empty database, so a run that
       * proved nothing has to be visible as such.
       */
      if (!legacyRows.length) {
        throw new Error(
          'The development database holds no in-stock offers, so the'
            + ' equivalence assertions above compared nothing. Restore a'
            + ' catalogue dump before trusting this suite.',
        );
      }

      expect(legacyRows.length).toBeGreaterThan(0);
    });
  });

  /**
   * A catalogue built to hit the branches an ambient database may or may not
   * contain, each one a case where the two forms could legitimately have
   * diverged.
   */
  describe('over a catalogue seeded for the edge cases', () => {
    let seeded: {
      legacy: SnapshotFields[];
      current: SnapshotFields[];
      since: Map<ID, string>;
      legacySince: Map<ID, string>;
      onceOnly: ID;
      neverHigher: ID;
      droppedAfterRise: ID;
      outOfStock: ReportCurrentRow | null;
    };

    beforeAll(async () => {
      seeded = await withRolledBackFixture(async () => {
        await clearCatalogue(dataSource);

        const storeRows = await dataSource.query(
          `INSERT INTO store (slug, name, "baseUrl", active)
           VALUES ($1, 'IT Equivalence', 'https://example.test', true)
           RETURNING id`,
          [SLUG],
        ) as { id: ID }[];

        const storeId = storeRows[0].id;

        /**
         * Creates one offer of its own bottling.
         *
         * @param key - Distinguishes the bottling and the offer's SKU.
         * @returns The new offer id.
         */
        const makeOffer = async (key: string): Promise<ID> => {
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

          const offer = await offers.upsertFromScrape({
            storeId,
            productId: [...ids.values()][0],
            sku: `sku-${key}`,
            url: `https://example.test/${key}`,
            nameOrig: `${TOKEN} ${key}`,
            seenOn: '2026-07-01',
          });

          if (!offer) {
            throw new Error('Offer upsert returned nothing');
          }

          return offer.id;
        };

        /**
         * Adds one snapshot with an explicit timestamp.
         *
         * The timestamp has to be written by hand rather than left to the
         * column default, and that is the whole reason this helper exists:
         * `createdAt` defaults to the transaction's start time, so a fixture
         * that seeded a series through `upsertForDate` would give every
         * snapshot of an offer the *same* `createdAt` — the one thing
         * production cannot produce (one row per offer per day, enforced by a
         * unique index) and the one thing that makes `LEAD` and the LATERAL
         * probe disagree. Seeding that would test a case the rewrite is
         * documented not to handle.
         *
         * @param offerId - The offer the snapshot belongs to.
         * @param day - Its capture day, also its timestamp.
         * @param price - The price observed that day.
         * @returns Resolves once the row exists.
         */
        const addSnapshot = async (
          offerId: ID,
          day: string,
          price: number,
        ): Promise<void> => {
          await dataSource.query(
            `INSERT INTO price_snapshot
               ("storeProductId", "capturedOn", "createdAt", price, currency,
                "inStock", promo)
             VALUES ($1, $2::date, $2::timestamp, $3, 'UAH', true, false)`,
            [offerId, day, price],
          );
        };

        const onceOnly = await makeOffer('once');

        await addSnapshot(onceOnly, '2026-07-02', 1000);

        const neverHigher = await makeOffer('rising');

        await addSnapshot(neverHigher, '2026-07-02', 800);
        await addSnapshot(neverHigher, '2026-07-03', 900);
        await addSnapshot(neverHigher, '2026-07-04', 1000);

        const droppedAfterRise = await makeOffer('dropped');

        await addSnapshot(droppedAfterRise, '2026-07-02', 700);
        await addSnapshot(droppedAfterRise, '2026-07-03', 1200);
        await addSnapshot(droppedAfterRise, '2026-07-04', 600);
        await addSnapshot(droppedAfterRise, '2026-07-05', 600);

        const gone = await makeOffer('gone');

        await addSnapshot(gone, '2026-07-02', 500);
        await addSnapshot(gone, '2026-07-03', 400);

        await dataSource.query(
          'UPDATE store_product SET "inStock" = false WHERE id = $1',
          [gone],
        );

        const legacyRows = await dataSource.query(
          `${LEGACY_CURRENT_SQL} AND sp."inStock"`,
        ) as ReportCurrentRow[];

        const rewritten = await offers.findCurrentRows({});

        const legacySinceRows = await dataSource.query(
          LEGACY_PRICE_SINCE_SQL,
        ) as { storeProductId: ID; since: string }[];

        return {
          legacy: byId(legacyRows.map(snapshotFields)),
          current: byId(rewritten.map(snapshotFields)),
          since: await snapshots.currentPriceSince(),
          legacySince: new Map(
            legacySinceRows.map((row) => [row.storeProductId, row.since]),
          ),
          onceOnly,
          neverHigher,
          droppedAfterRise,
          outOfStock: await offers.findCurrentRowById(gone),
        };
      });
    });

    it('agrees with the window form on every seeded offer', () => {
      expect(seeded.current).toEqual(seeded.legacy);
      expect(seeded.current).toHaveLength(3);
    });

    it('leaves the previous price null for a one-snapshot offer', () => {
      const row = seeded.current.find((item) => item.id === seeded.onceOnly);

      expect(row?.previousPrice).toBeNull();
      expect(row?.price).toBe(1000);
    });

    it('reads the previous price from the day before, not the cheapest', () => {
      const row = seeded.current
        .find((item) => item.id === seeded.droppedAfterRise);

      expect(row?.price).toBe(600);
      expect(row?.previousPrice).toBe(600);
    });

    it('dates a price that was never higher from the first snapshot', () => {
      expect(seeded.since.get(seeded.neverHigher)).toBe('2026-07-02');
    });

    it('dates a price that fell from the day after the last higher one', () => {
      expect(seeded.since.get(seeded.droppedAfterRise)).toBe('2026-07-04');
    });

    it('agrees with the legacy form on every seeded date', () => {
      expect([...seeded.since.entries()].sort())
        .toEqual([...seeded.legacySince.entries()].sort());
    });

    it('still reads an out-of-stock offer by id', () => {
      expect(seeded.outOfStock?.inStock).toBe(false);
      expect(seeded.outOfStock?.price).toBe(400);
      expect(seeded.outOfStock?.previousPrice).toBe(500);
    });
  });
});
