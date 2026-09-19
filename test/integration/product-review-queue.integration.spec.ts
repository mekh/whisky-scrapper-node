import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CoreCountryService } from '~core/country';
import { CorePreferenceService } from '~core/preference';
import { CorePriceSnapshotService } from '~core/price-snapshot';
import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import {
  ProductReviewStatus,
  ReportKind,
  ReportWindow,
  ReviewQueueStatus,
  SortOrder,
} from '~enums';
import type {
  ID,
  MetaCountry,
  ProductReviewStatusCounts,
  ReportOptions,
  ReportPublicGroup,
  ReviewQueueRow,
} from '~types';

import { ReportService } from '../../src/domain/report/report.service';

import { passthroughCache } from '../cache-stub';
import { clearCatalogue, withRolledBackFixture } from './database-fixture';
import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

/**
 * Any uuid reads as "a user with no preferences": the per-user predicates are
 * anti-joins against tables this suite never writes.
 */
const USER_ID = '0198d1f6-0000-7000-8000-0000000000d1' as ID;

const STAMP = Date.now();

const TOKEN = `itqueue${STAMP}`;

/**
 * Two shops, because `best` only compares a bottling carried by at least two.
 */
const SLUGS = [`__it_q_a_${STAMP}`, `__it_q_b_${STAMP}`];

/**
 * The country only the rejected bottling uses, so `/meta`'s country list
 * answers the question on its own.
 */
const LONELY_COUNTRY = 'JP';

const OPTIONS: ReportOptions = {
  window: ReportWindow.WEEK,
  order: SortOrder.ASC,
  page: 1,
  perPage: 100,
};

/**
 * Yesterday and today as UTC calendar days.
 *
 * Real dates rather than fixed ones: `new` measures recency against the real
 * current date and `drops` reads the clock for `daysDiscount`, so a hardcoded
 * day would make two of the five kinds silently empty.
 *
 * @param back - How many days before today.
 * @returns The day as `YYYY-MM-DD`.
 */
function dayOf(back: number): string {
  const date = new Date();

  date.setUTCDate(date.getUTCDate() - back);

  return date.toISOString().slice(0, 10);
}

const YESTERDAY = dayOf(1);

const TODAY = dayOf(0);

/**
 * The three bottlings this suite seeds, one per place in the queue.
 */
const CASES = [
  { label: 'Pending', status: ProductReviewStatus.PENDING },
  { label: 'Verified', status: ProductReviewStatus.VERIFIED },
  { label: 'Rejected', status: ProductReviewStatus.REJECTED },
];

/**
 * Everything the assertions read, gathered while the fixture transaction is
 * still open.
 */
interface QueueFixture {
  /**
   * The names each report kind returned.
   */
  reports: Record<string, string[]>;

  /**
   * Country codes `/meta` offers as filter options.
   */
  countries: string[];

  /**
   * In-stock listings the first shop reports.
   */
  storeCount: number;

  /**
   * Whether the single-offer read still answers for the rejected bottling.
   */
  historyRow: boolean;

  /**
   * Whether `?term=` still resolves the rejected bottling's offer.
   */
  resolvedByTerm: boolean;

  /**
   * Names the autocomplete offers for the suite's token.
   */
  searchHits: string[];

  /**
   * Names in the `pending` bucket of the queue.
   */
  queuePending: string[];

  /**
   * Names in the `rejected` bucket.
   */
  queueRejected: string[];

  /**
   * One queue row, for its field shape.
   */
  queueRow: ReviewQueueRow | undefined;

  /**
   * The queue counters, and the table's own row count beside them.
   */
  counts: ProductReviewStatusCounts;

  /**
   * How many rows `product` holds — the sum the counters must match.
   */
  total: number;

  /**
   * The status of a bottling the batch upsert just created.
   */
  createdStatus: string | null;

  /**
   * The status of a bottling `createUnmatched` just created.
   */
  unmatchedStatus: string | null;

  /**
   * The status of a row that predates the queue, after a shop lists it again.
   */
  relistedLegacy: string | null;

  /**
   * The status of a reviewed row, after a shop lists it again.
   */
  relistedVerified: string | null;

  /**
   * What a re-sync does to a rejected bottling.
   */
  afterResync: { status: string | null; offers: number; snapshots: number };
}

/**
 * The new-product queue against the live database.
 *
 * Two things are proved here and nowhere else. **Enrolment is the column
 * default**, so a row a sync creates is in the queue without any insert path
 * naming the column — and a row that predates the queue, or one somebody has
 * already reviewed, is not put into it when a shop lists it again tomorrow.
 * And **`rejected` is a read filter, not a deletion**: it disappears from all
 * five report kinds, from the country options and from a shop's listing count,
 * while the single-offer read, `?term=` and the autocomplete still answer for
 * it, because the verdict is reversible and unreachable rows cannot be
 * reversed.
 *
 * Every row it reads is a row it wrote, inside a transaction it rolls back.
 */
describe('the new-product review queue (integration)', () => {
  let moduleRef: TestingModule;
  let fixture: QueueFixture;

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();

    const dataSource = moduleRef.get(DataSource);
    const products = moduleRef.get(CoreProductService, { strict: false });
    const offers = moduleRef.get(CoreStoreProductService, { strict: false });
    const countries = moduleRef.get(CoreCountryService, { strict: false });
    const snapshots = moduleRef.get(CorePriceSnapshotService, {
      strict: false,
    });
    const preferences = moduleRef.get(CorePreferenceService, {
      strict: false,
    });

    const report = new ReportService(
      offers,
      snapshots,
      preferences,
      passthroughCache(),
    );

    const names = (groups: ReportPublicGroup[]): string[] =>
      groups.map((group) => group.name ?? group.nameOrig ?? '');

    const runKind = async (kind: ReportKind): Promise<string[]> => {
      const page = await report.report(
        kind,
        { name: TOKEN },
        OPTIONS,
        { userId: USER_ID },
      );

      return names(page.data);
    };

    fixture = await withRolledBackFixture(async () => {
      await clearCatalogue(dataSource);

      const storeIds = await seedStores(dataSource);
      // The resolver keys its answer by the lowercased name.
      const resolved = await countries.resolveByNameUa(['Японія']);
      const japan = resolved.get('японія');

      if (!japan) {
        throw new Error('The `JP` country row is missing');
      }

      const seeded = await seedCases(
        dataSource,
        { products, offers, snapshots },
        { storeIds, countryId: japan },
      );

      const rejectedOffer = await firstOfferOf(
        dataSource,
        seeded.get('Rejected') as ID,
      );

      const reports: Record<string, string[]> = {};

      for (const kind of Object.values(ReportKind)) {
        reports[kind] = await runKind(kind);
      }

      const noHits = { rejected: [], withheld: [] };

      const pending = await products.findReviewQueue(
        { name: TOKEN, includeUnstocked: true },
        noHits,
      );

      const rejected = await products.findReviewQueue(
        {
          name: TOKEN,
          status: ReviewQueueStatus.REJECTED,
          includeUnstocked: true,
        },
        noHits,
      );

      const totals = await dataSource.query(
        'SELECT count(*)::int AS total FROM product',
      ) as { total: number }[];

      return {
        reports,
        countries: (await offers.distinctCountries() as MetaCountry[])
          .map((country) => country.code),
        storeCount: await offers.countByStore(storeIds[0] as ID),
        historyRow: await offers.findCurrentRowById(rejectedOffer) !== null,
        resolvedByTerm:
          await offers.resolveIdByTerm(`${TOKEN} Rejected`) !== null,
        searchHits: (await products.search(TOKEN, 20))
          .map((item) => item.name ?? ''),
        queuePending: pending.rows.map((row) => row.name ?? ''),
        queueRejected: rejected.rows.map((row) => row.name ?? ''),
        queueRow: pending.rows[0],
        counts: await products.countReviewStatuses(),
        total: totals[0]?.total ?? 0,
        ...await probeSyncPaths(
          dataSource,
          { products, offers, snapshots },
          storeIds[0] as ID,
        ),
        afterResync: await probeResync(
          dataSource,
          { products, offers, snapshots },
          {
            storeId: storeIds[0] as ID,
            productId: seeded.get('Rejected') as ID,
          },
        ),
      };
    });
  });

  afterAll(async () => {
    await closeIntegrationModule(moduleRef);
  });

  describe('enrolment', () => {
    it('puts a bottling the batch upsert created into the queue', () => {
      expect(fixture.createdStatus).toBe(ProductReviewStatus.PENDING);
    });

    it('puts an unmatched bottling into it as well', () => {
      /**
       * The second of the three insert paths, and the one that proves the
       * column default rather than a hook: neither statement names the column.
       */
      expect(fixture.unmatchedStatus).toBe(ProductReviewStatus.PENDING);
    });

    it('leaves a bottling that predates the queue out of it', () => {
      /**
       * The migration's whole point. Enrolling the existing catalogue is a
       * separate decision with its own window, so a null row stays null — and
       * the no-op `ON CONFLICT DO UPDATE` is what keeps a shop re-listing it
       * from enrolling it by accident.
       */
      expect(fixture.relistedLegacy).toBeNull();
    });

    it('does not push a reviewed bottling back into the queue', () => {
      expect(fixture.relistedVerified).toBe(ProductReviewStatus.VERIFIED);
    });
  });

  describe('a rejected bottling', () => {
    it('is gone from every one of the five reports', () => {
      Object.values(ReportKind).forEach((kind) => {
        expect(fixture.reports[kind]).not.toContain(`${TOKEN} Rejected`);
      });
    });

    it('does not take the other two with it', () => {
      /**
       * The control. Without it a predicate written `<> 'rejected'` — which
       * is NULL for every legacy row and fails the `AND` — would pass the
       * test above while hiding the whole catalogue.
       */
      Object.values(ReportKind).forEach((kind) => {
        expect(fixture.reports[kind]).toContain(`${TOKEN} Pending`);
        expect(fixture.reports[kind]).toContain(`${TOKEN} Verified`);
      });
    });

    it('stops offering its country as a filter option', () => {
      expect(fixture.countries).not.toContain(LONELY_COUNTRY);
    });

    it('is not counted among the listings of a shop', () => {
      expect(fixture.storeCount).toBe(CASES.length - 1);
    });

    it('is still readable as a single offer', () => {
      /**
       * The verdict is reversible, so the product card has to keep answering
       * for it — filtering here would make un-rejecting unreachable.
       */
      expect(fixture.historyRow).toBe(true);
    });

    it('still resolves from a history term', () => {
      expect(fixture.resolvedByTerm).toBe(true);
    });

    it('is still offered by the autocomplete', () => {
      /**
       * The relink picker has to reach it in order to move a listing off it.
       */
      expect(fixture.searchHits).toContain(`${TOKEN} Rejected`);
    });

    it('is not resurrected by the next sync', () => {
      /**
       * The scrape keeps collecting: the offer is upserted and the day's
       * snapshot written, so the price history survives the rejection and
       * un-rejecting costs nothing. What does not happen is the row being
       * re-created as pending — key and identity resolution still reach it.
       */
      expect(fixture.afterResync.status).toBe(ProductReviewStatus.REJECTED);
      expect(fixture.afterResync.offers).toBe(1);
      expect(fixture.afterResync.snapshots).toBeGreaterThan(0);
    });
  });

  describe('the queue listing', () => {
    it('lists the pending bottling and not the others', () => {
      expect(fixture.queuePending).toEqual([`${TOKEN} Pending`]);
    });

    it('lists a rejected bottling in its own bucket', () => {
      expect(fixture.queueRejected).toEqual([`${TOKEN} Rejected`]);
    });

    it('carries both names, the key and the specs', () => {
      /**
       * The pair of names is the review: everything the cleaner dropped is
       * the difference between them. The key is here because it is frozen at
       * creation and this is the only cheap moment to notice a wrong one.
       */
      expect(fixture.queueRow).toEqual(expect.objectContaining({
        name: `${TOKEN} Pending`,
        nameOrig: `Віскі ${TOKEN} Pending 0,7л`,
        matchKey: `${TOKEN}-Pending`,
        age: 12,
        volumeMl: 700,
        reviewStatus: ProductReviewStatus.PENDING,
      }));
      expect(fixture.queueRow?.offers).toHaveLength(SLUGS.length);
      expect(fixture.queueRow?.storeCount).toBe(SLUGS.length);
    });
  });

  it('counts the whole catalogue across the four states', () => {
    /**
     * The invariant that says null is the only fourth state — and the reason
     * `legacy` is served rather than derived.
     */
    const { pending, verified, rejected, legacy } = fixture.counts;

    expect(pending + verified + rejected + legacy).toBe(fixture.total);
  });
});

/**
 * Creates the two shops the seeded offers hang off.
 *
 * @param dataSource - The suite's data source.
 * @returns Their ids, in `SLUGS` order.
 */
async function seedStores(dataSource: DataSource): Promise<ID[]> {
  const ids: ID[] = [];

  for (const slug of SLUGS) {
    const rows = await dataSource.query(
      `INSERT INTO store (slug, name, "baseUrl", active)
       VALUES ($1, $1, 'https://example.test', true)
       RETURNING id`,
      [slug],
    ) as { id: ID }[];

    const storeId = rows[0]?.id;

    if (!storeId) {
      throw new Error('Store insert returned nothing');
    }

    await dataSource.query(
      `INSERT INTO store_config
         ("storeId", tier, "delayFrom", "delayTo", "needsBrowser", engine)
       VALUES ($1, 1, 0, 0, false, 'ts')`,
      [storeId],
    );

    ids.push(storeId);
  }

  return ids;
}

/**
 * Seeds one bottling per case, listed in both shops at a price that fell
 * overnight so every report kind has material: `new` from today's
 * `firstSeen`, `drops` and `low` from yesterday's higher price, `best` from
 * the two shops disagreeing.
 *
 * @param dataSource - The suite's data source.
 * @param services - The core services the write path goes through.
 * @param target - The shops to list in and the country to stamp.
 * @returns Case label to bottling id.
 */
async function seedCases(
  dataSource: DataSource,
  services: {
    products: CoreProductService;
    offers: CoreStoreProductService;
    snapshots: CorePriceSnapshotService;
  },
  target: { storeIds: ID[]; countryId: ID },
): Promise<Map<string, ID>> {
  const seeded = new Map<string, ID>();

  for (const { label, status } of CASES) {
    const name = `${TOKEN} ${label}`;

    const { ids } = await services.products.findOrCreateByMatchKeys([{
      factSources: {},
      matchKey: `${TOKEN}-${label}`,
      name,
      brandOrig: null,
      typeId: null,
      countryId: label === 'Rejected' ? target.countryId : null,
      age: 12,
      abv: null,
      volumeMl: 700,
    }]);

    const productId = [...ids.values()][0] as ID;

    seeded.set(label, productId);

    await services.products.applyReviewStatus([productId], status);

    let price = 1000;

    for (const storeId of target.storeIds) {
      const offer = await services.offers.upsertFromScrape({
        storeId,
        productId,
        sku: `${TOKEN}-${label}-${storeId}`,
        url: `https://example.test/${label}`,
        nameOrig: `Віскі ${name} 0,7л`,
        seenOn: TODAY,
      });

      if (!offer) {
        throw new Error('Offer upsert returned nothing');
      }

      await services.snapshots.upsertForDate(offer.id, YESTERDAY, {
        price: price + 300,
        oldPrice: null,
        currency: 'UAH',
        inStock: true,
        promo: false,
      });
      await services.snapshots.upsertForDate(offer.id, TODAY, {
        price,
        oldPrice: null,
        currency: 'UAH',
        inStock: true,
        promo: false,
      });

      price += 100;
    }

    await dataSource.query(
      'UPDATE store_product SET "firstSeen" = $2 WHERE "productId" = $1',
      [productId, TODAY],
    );
  }

  /**
   * Spaces the snapshots out in `createdAt`, not only in `capturedOn`.
   *
   * Necessary, not cosmetic: `now()` is fixed for the whole transaction in
   * Postgres, so every row this fixture writes carries the *same* default
   * `createdAt` — and the previous-price lateral pairs a snapshot with the
   * one before it by `createdAt <`, which then matches nothing. Without this,
   * `previousPrice` is null on every seeded offer and the `low` report, whose
   * discount is measured against exactly that, comes back empty while the
   * other four look fine.
   */
  await dataSource.query(
    `UPDATE price_snapshot
     SET "createdAt" = "capturedOn"::timestamp + interval '12 hours'
     WHERE "storeProductId" IN (
       SELECT sp.id FROM store_product sp
       JOIN product p ON p.id = sp."productId"
       WHERE p.name LIKE $1)`,
    [`${TOKEN}%`],
  );

  return seeded;
}

/**
 * The first offer of a bottling.
 *
 * @param dataSource - The suite's data source.
 * @param productId - The bottling.
 * @returns The offer's id.
 */
async function firstOfferOf(
  dataSource: DataSource,
  productId: ID,
): Promise<ID> {
  const rows = await dataSource.query(
    'SELECT id FROM store_product WHERE "productId" = $1 ORDER BY id LIMIT 1',
    [productId],
  ) as { id: ID }[];

  const id = rows[0]?.id;

  if (!id) {
    throw new Error('The seeded bottling has no offer');
  }

  return id;
}

/**
 * Exercises what each insert path and each re-listing does to the column.
 *
 * @param dataSource - The suite's data source.
 * @param services - The core services the write path goes through.
 * @param storeId - The shop to list in.
 * @returns The four statuses the assertions read.
 */
async function probeSyncPaths(
  dataSource: DataSource,
  services: {
    products: CoreProductService;
    offers: CoreStoreProductService;
    snapshots: CorePriceSnapshotService;
  },
  storeId: ID,
): Promise<{
  createdStatus: string | null;
  unmatchedStatus: string | null;
  relistedLegacy: string | null;
  relistedVerified: string | null;
}> {
  /**
   * Reads one bottling's status.
   *
   * @param id - The bottling.
   * @returns Its status.
   */
  const statusOf = async (id: ID): Promise<string | null> => {
    const rows = await dataSource.query(
      'SELECT "reviewStatus" FROM product WHERE id = $1',
      [id],
    ) as { reviewStatus: string | null }[];

    return rows[0]?.reviewStatus ?? null;
  };

  /**
   * Creates a bottling through the batch upsert.
   *
   * @param key - Its match key suffix.
   * @returns The new id.
   */
  const created = async (key: string): Promise<ID> => {
    const { ids } = await services.products.findOrCreateByMatchKeys([{
      factSources: {},
      matchKey: `${TOKEN}-${key}`,
      name: `${TOKEN} ${key}`,
      brandOrig: null,
      typeId: null,
      countryId: null,
      age: null,
      abv: null,
      volumeMl: 700,
    }]);

    return [...ids.values()][0] as ID;
  };

  const batch = await created('Batch');

  const unmatched = await services.products.createUnmatched({
    factSources: {},
    matchKey: null,
    name: `${TOKEN} Unmatched`,
    brandOrig: null,
    typeId: null,
    countryId: null,
    age: null,
    abv: null,
    volumeMl: null,
  });

  const legacy = await created('Legacy');
  const reviewed = await created('Reviewed');

  await dataSource.query(
    'UPDATE product SET "reviewStatus" = NULL WHERE id = $1',
    [legacy],
  );
  await services.products.applyReviewStatus(
    [reviewed],
    ProductReviewStatus.VERIFIED,
  );

  /**
   * Lists a bottling again, exactly as the next sync would: the same key
   * through the batch upsert, then the offer.
   *
   * @param id - The bottling already on file.
   * @param key - Its match key suffix.
   * @returns Nothing.
   */
  const relist = async (id: ID, key: string): Promise<void> => {
    await created(key);
    await services.offers.upsertFromScrape({
      storeId,
      productId: id,
      sku: `${TOKEN}-${key}`,
      url: `https://example.test/${key}`,
      nameOrig: `Віскі ${TOKEN} ${key}`,
      seenOn: TODAY,
    });
  };

  await relist(legacy, 'Legacy');
  await relist(reviewed, 'Reviewed');

  return {
    createdStatus: await statusOf(batch),
    unmatchedStatus: await statusOf(unmatched),
    relistedLegacy: await statusOf(legacy),
    relistedVerified: await statusOf(reviewed),
  };
}

/**
 * Re-scrapes a rejected bottling and reports what the run left behind.
 *
 * @param dataSource - The suite's data source.
 * @param services - The core services the write path goes through.
 * @param target - The shop and the rejected bottling.
 * @returns Its status, its offer count and its snapshot count.
 */
async function probeResync(
  dataSource: DataSource,
  services: {
    products: CoreProductService;
    offers: CoreStoreProductService;
    snapshots: CorePriceSnapshotService;
  },
  target: { storeId: ID; productId: ID },
): Promise<{ status: string | null; offers: number; snapshots: number }> {
  const { ids } = await services.products.findOrCreateByMatchKeys([{
    factSources: {},
    matchKey: `${TOKEN}-Rejected`,
    name: `${TOKEN} Rejected`,
    brandOrig: null,
    typeId: null,
    countryId: null,
    age: 12,
    abv: null,
    volumeMl: 700,
  }]);

  const resolved = [...ids.values()][0] as ID;

  if (resolved !== target.productId) {
    throw new Error('A re-listed rejected bottling resolved to a new row');
  }

  const offer = await services.offers.upsertFromScrape({
    storeId: target.storeId,
    productId: resolved,
    sku: `${TOKEN}-Rejected-${target.storeId}`,
    url: 'https://example.test/Rejected',
    nameOrig: `Віскі ${TOKEN} Rejected 0,7л`,
    seenOn: TODAY,
  });

  if (offer) {
    await services.snapshots.upsertForDate(offer.id, TODAY, {
      price: 990,
      oldPrice: null,
      currency: 'UAH',
      inStock: true,
      promo: false,
    });
  }

  const rows = await dataSource.query(
    `SELECT p."reviewStatus",
            (SELECT count(*)::int FROM store_product sp
             WHERE sp."productId" = p.id AND sp."storeId" = $2) AS offers,
            (SELECT count(*)::int FROM price_snapshot s
             JOIN store_product sp2 ON sp2.id = s."storeProductId"
             WHERE sp2."productId" = p.id) AS snapshots
     FROM product p WHERE p.id = $1`,
    [resolved, target.storeId],
  ) as { reviewStatus: string | null; offers: number; snapshots: number }[];

  const row = rows[0];

  return {
    status: row?.reviewStatus ?? null,
    offers: row?.offers ?? 0,
    snapshots: row?.snapshots ?? 0,
  };
}
