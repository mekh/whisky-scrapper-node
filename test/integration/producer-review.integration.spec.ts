import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CoreProducerService } from '~core/producer';
import { CoreProductService } from '~core/product';
import { ProducerKind, KbStatus, PeatProfile } from '~enums';
import {
  KbApplyService,
  KbReconcileService,
  KbResolverService,
} from '~scrape/kb';
import type {
  ProducerDetail,
  ProducerReviewRow,
  ID,
  KbAliasEntry,
  ProductFactReviewRow,
  ProductReviewSummary,
  TypePaginated,
  UntrustedFactCounts,
} from '~types';

import type { KbReconcileRun } from '../../src/scrape/kb/kb.interfaces';

import { ProducerReachService } from '../../src/domain/product/producer-reach.service';
import { ProductReviewService } from '../../src/domain/product/product-review.service';

import {
  clearCatalogue,
  clearKnowledgeBase,
  withRolledBackFixture,
} from './database-fixture';
import {
  bootIntegrationModule,
  closeIntegrationModule,
} from './integration-module';

/**
 * Prefix on every row this suite writes, so a fixture is recognisable in a
 * failure message and can never be confused with a seeded row.
 */
const TAG = 'itdr';

/**
 * How many withheld producers the fixture installs. Each is reached by a
 * different number of bottlings, which is what the ranking assertion needs.
 */
const WITHHELD = 3;

/**
 * How many shops list the widely-carried bottling. Deliberately above the
 * five-link cap, and one of them lists it twice.
 */
const SHOPS = 6;

/**
 * Everything the assertions read, gathered while the fixture transaction is
 * still open.
 */
interface ReviewFixture {
  /**
   * The detail read of the parent producer, with its children and the
   * global peat rules.
   */
  detail: ProducerDetail;

  /**
   * The withheld queue, ranked.
   */
  withheldPage: TypePaginated<ProducerReviewRow>;

  /**
   * The `auto` tab.
   */
  autoPage: TypePaginated<ProducerReviewRow>;

  /**
   * The `verified` tab.
   */
  verifiedPage: TypePaginated<ProducerReviewRow>;

  /**
   * Every withheld row, unpaged, as the listing returns it.
   */
  fullUnverified: { rows: ProducerReviewRow[]; total: number };

  /**
   * The tab counters.
   */
  summary: ProductReviewSummary;

  /**
   * Ids of the producers the fixture rejected.
   */
  rejectedIds: ID[];

  /**
   * The resolver's own alias index.
   */
  aliasIndex: KbAliasEntry[];

  /**
   * The untrusted-fact queue, both halves.
   */
  factsPage: { rows: ProductFactReviewRow[]; total: number };

  /**
   * The untrusted-fact queue restricted to bottlings that resolve.
   */
  resolvedFacts: { rows: ProductFactReviewRow[]; total: number };

  /**
   * The untrusted-fact queue restricted to bottlings that do not.
   */
  unresolvedFacts: { rows: ProductFactReviewRow[]; total: number };

  /**
   * The badge counters behind the facts tab.
   */
  factCounts: UntrustedFactCounts;

  /**
   * The same `either` count, taken straight from SQL.
   */
  directEither: number;

  /**
   * Bottlings linked to a producer before the dry run.
   */
  linkedBefore: number;

  /**
   * Bottlings linked to a producer after it.
   */
  linkedAfter: number;

  /**
   * The dry run itself.
   */
  dryRun: KbReconcileRun;

  /**
   * A dry run narrowed to one brand.
   */
  brandRun: KbReconcileRun;
}

/**
 * The curation screen's read side.
 *
 * **The suite owns every row it looks at.** It empties the catalogue and the
 * knowledge base inside a transaction, installs a small one of its own — a
 * parent with two peated child lines, one `verified`, one `auto`, three
 * withheld and one `rejected` producer, the global peat rules, and a handful
 * of bottlings with untrusted facts — asserts against that, and rolls the
 * whole thing back.
 *
 * It used to read whatever the shared development database happened to hold,
 * which made it a test of one machine's review history: it needed a `verified`
 * row and a `rejected` one to exist, so it passed only where somebody had
 * pressed those buttons, and every count it checked was a property of that
 * day's catalogue rather than of the code.
 */
describe('producer review (integration)', () => {
  let moduleRef: TestingModule;
  let fixture: ReviewFixture;

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();

    const dataSource = moduleRef.get(DataSource);
    const producers = moduleRef.get(CoreProducerService, {
      strict: false,
    });
    const products = moduleRef.get(CoreProductService, { strict: false });

    const resolver = new KbResolverService();
    const reconcile = new KbReconcileService(
      producers,
      products,
      new KbApplyService(resolver),
    );

    const review = new ProductReviewService(
      producers,
      products,
      new ProducerReachService(producers, products, resolver),
      reconcile,
    );

    fixture = await withRolledBackFixture(async () => {
      await clearCatalogue(dataSource);
      await clearKnowledgeBase(dataSource);
      await seedKnowledgeBase(dataSource);
      await seedCatalogue(dataSource);

      const parent = await scalar<ID>(
        dataSource,
        `SELECT id FROM producer WHERE slug = '${TAG}-parent'`,
      );

      const rejected = await dataSource.query(
        "SELECT id FROM producer WHERE status = 'rejected'",
      ) as { id: ID }[];

      const linkedBefore = await countLinked(dataSource);
      const dryRun = await reconcile.run({ dryRun: true });
      const linkedAfter = await countLinked(dataSource);

      return {
        detail: await review.producerDetail(parent),
        withheldPage: await review.producersPage({
          status: KbStatus.UNVERIFIED,
          page: 1,
          perPage: 20,
        }),
        autoPage: await review.producersPage({
          status: KbStatus.AUTO,
          page: 1,
          perPage: 20,
        }),
        verifiedPage: await review.producersPage({
          status: KbStatus.VERIFIED,
          page: 1,
          perPage: 20,
        }),
        fullUnverified: await producers.listForReview(
          KbStatus.UNVERIFIED,
          null,
          0,
        ),
        summary: await review.summary(),
        rejectedIds: rejected.map((row) => row.id),
        aliasIndex: await producers.loadAliasIndex(),
        factsPage: await products.findUntrustedFacts(undefined, 50, 0),
        resolvedFacts: await products.findUntrustedFacts(
          undefined,
          50,
          0,
          'resolved',
        ),
        unresolvedFacts: await products.findUntrustedFacts(
          undefined,
          50,
          0,
          'unresolved',
        ),
        factCounts: await products.countUntrustedFacts(),
        directEither: await countUntrustedDirectly(dataSource),
        linkedBefore,
        linkedAfter,
        dryRun,
        brandRun: await reconcile.run({
          dryRun: true,
          brand: `${TAG} Widely Carried`,
        }),
      };
    });
  });

  afterAll(async () => {
    await closeIntegrationModule(moduleRef);
  });

  /**
   * The owner's own question — "what do I pick for a producer that makes
   * both?" — is only answered if the override is visible on the detail read
   * itself, not merely present somewhere in the schema. The parent carries
   * `none`; its two named lines carry `heavy` as their own claim, never
   * inherited from it.
   */
  it("surfaces a producer's child overrides and global peat rules", () => {
    expect(fixture.detail.producer.slug).toBe(`${TAG}-parent`);
    expect(fixture.detail.producer.peatProfile).toBe(PeatProfile.NONE);

    const children = fixture.detail.children
      .map((child) => child.slug)
      .sort();

    expect(children).toEqual([`${TAG}-child-a`, `${TAG}-child-b`]);

    fixture.detail.children.forEach((child) => {
      expect(child.peatProfile).toBe(PeatProfile.HEAVY);
    });

    const unpeated = fixture.detail.globalPeatRules.find(
      (rule) => rule.pattern === 'unpeated',
    );

    const peated = fixture.detail.globalPeatRules.find(
      (rule) => rule.pattern === 'peated',
    );

    expect(unpeated).toEqual(expect.objectContaining({
      priority: 100,
      peatProfile: PeatProfile.NONE,
    }));

    expect(peated).toEqual(expect.objectContaining({
      priority: 50,
      peatProfile: PeatProfile.HEAVY,
    }));
  });

  /**
   * `productCount` is structurally zero for every withheld row — the
   * resolver's index only ever loads `verified`/`auto` — so ordering the tab
   * by it would rank alphabetically. `potentialReach` is the ranking signal
   * instead, and the fixture gives its three withheld rows three different
   * reaches so the order is a fact rather than a coincidence.
   */
  it('ranks the withheld queue by potential reach, not product count', () => {
    const slugs = fixture.withheldPage.data.map((row) => row.slug);

    expect(slugs).toEqual([
      `${TAG}-withheld-1`,
      `${TAG}-withheld-2`,
      `${TAG}-withheld-3`,
    ]);

    fixture.withheldPage.data.forEach((row) => {
      expect(row.productCount).toBe(0);
    });

    expect(fixture.withheldPage.data.map((row) => row.potentialReach))
      .toEqual([3, 2, 1]);
  });

  /**
   * Null is the contract for "this tab shows a real count instead" — a
   * `verified`/`auto` row's `productCount` is already a fact, so nothing
   * computes a second, redundant ranking number for it.
   */
  it('leaves potentialReach null once a producer has a real count', () => {
    expect(fixture.autoPage.data.map((row) => row.slug))
      .toEqual([`${TAG}-auto`]);

    expect(fixture.verifiedPage.data.map((row) => row.slug).sort())
      .toEqual([`${TAG}-child-a`, `${TAG}-child-b`, `${TAG}-parent`]);

    [...fixture.autoPage.data, ...fixture.verifiedPage.data].forEach((row) => {
      expect(row.potentialReach).toBeNull();
    });
  });

  /**
   * The important one: a `rejected` producer must be invisible not only to
   * the review queue's listing but to the resolver's own alias index, which
   * is what the sync path actually reads. The fixture gives the rejected row
   * an alias precisely so the index has something to leak.
   */
  it('keeps a rejected producer out of the queue and the resolver', () => {
    expect(fixture.rejectedIds).toHaveLength(1);
    expect(fixture.summary.producers.rejected).toBe(1);

    expect(fixture.fullUnverified.rows.map((row) => row.slug).sort())
      .toEqual([
        `${TAG}-withheld-1`,
        `${TAG}-withheld-2`,
        `${TAG}-withheld-3`,
      ]);

    const rejected = new Set(fixture.rejectedIds);

    expect(fixture.aliasIndex.length).toBeGreaterThan(0);

    fixture.aliasIndex.forEach((alias) => {
      expect(rejected.has(alias.producer.id)).toBe(false);
    });
  });

  /**
   * The actual regression this pins: the client used to sum the two
   * per-field counts, which double-counts every bottling untrusted on both
   * fields at once. The fixture plants exactly one such bottling, so `either`
   * is strictly below the sum rather than merely not above it.
   */
  it('counts the facts badge distinctly instead of summing the fields', () => {
    expect(fixture.factCounts.either).toBe(fixture.directEither);
    expect(fixture.factCounts.type).toBe(2);
    expect(fixture.factCounts.country).toBe(2);
    expect(fixture.factCounts.either).toBe(3);
  });

  /**
   * The queue's two halves are two different jobs — a bottling that resolves
   * to nothing is cured a producer at a time, one that resolves is a call
   * only a person can make — so the split has to be a real filter and the
   * halves have to add up.
   */
  it('splits the facts queue by whether the bottling resolves', () => {
    expect(fixture.resolvedFacts.total + fixture.unresolvedFacts.total)
      .toBe(fixture.factsPage.total);

    fixture.resolvedFacts.rows.forEach((row) => {
      expect(row.producerSlug).not.toBeNull();
    });

    fixture.unresolvedFacts.rows.forEach((row) => {
      expect(row.producerSlug).toBeNull();
    });

    expect(fixture.factCounts.eitherUnresolved)
      .toBe(fixture.unresolvedFacts.total);
  });

  /**
   * `stores` is capped at five and deduped per shop (`DISTINCT ON`) — a shop
   * that lists the same bottling under two SKUs (boxed and plain) used to
   * take two of the five slots instead of one. The fixture lists one bottling
   * in six shops, one of them twice, which is the only arrangement that fails
   * on either bug.
   */
  it('dedupes and caps the store links on a facts row', () => {
    const widely = fixture.factsPage.rows.find(
      (row) => row.name === `${TAG} Widely Carried`,
    );

    expect(widely).toBeDefined();
    expect(widely?.storeCount).toBe(SHOPS);
    expect(widely?.stores).toHaveLength(5);

    const slugs = widely?.stores.map((store) => store.slug) ?? [];

    expect(new Set(slugs).size).toBe(slugs.length);

    fixture.factsPage.rows.forEach((row) => {
      row.stores.forEach((store) => {
        expect(store.url.length).toBeGreaterThan(0);
      });
    });
  });

  /**
   * The pass is the missing half of every decision the review screen records:
   * promoting a producer stores a claim, and nothing points at that
   * producer until the catalogue is re-resolved. This asserts the plan is
   * built over the fixture's catalogue and that `dryRun` is honoured.
   */
  it('plans the catalogue and writes nothing on a dry run', () => {
    expect(fixture.dryRun.summary.groups).toBeGreaterThan(0);
    expect(fixture.dryRun.summary.resolved).toBeGreaterThan(0);
    expect(fixture.dryRun.summary.resolved)
      .toBeLessThanOrEqual(fixture.dryRun.summary.groups);

    expect(fixture.dryRun.summary.producerWrites).toBe(0);
    expect(fixture.dryRun.summary.factWrites).toBe(0);
    expect(fixture.dryRun.summary.flavorWrites).toBe(0);
    expect(fixture.dryRun.plan.groups)
      .toHaveLength(fixture.dryRun.summary.groups);

    expect(fixture.linkedAfter).toBe(fixture.linkedBefore);
  });

  it('narrows the pass to one brand', () => {
    expect(fixture.brandRun.rows.length).toBeGreaterThan(0);
    expect(fixture.brandRun.summary.groups)
      .toBeLessThan(fixture.dryRun.summary.groups);
  });
});

/**
 * Reads a single value out of a query that returns one row and one column.
 *
 * @param dataSource - The suite's data source.
 * @param sql - The query.
 * @returns The value.
 * @throws {Error} When the query matched nothing.
 */
async function scalar<T>(dataSource: DataSource, sql: string): Promise<T> {
  const rows = await dataSource.query(sql) as Record<string, T>[];
  const first = rows[0];

  if (!first) {
    throw new Error(`Fixture query returned no row: ${sql}`);
  }

  return Object.values(first)[0] as T;
}

/**
 * Counts the bottlings currently linked to a producer.
 *
 * @param dataSource - The suite's data source.
 * @returns How many.
 */
async function countLinked(dataSource: DataSource): Promise<number> {
  return scalar<number>(
    dataSource,
    'SELECT count(*)::int FROM product WHERE "producerId" IS NOT NULL',
  );
}

/**
 * Counts the untrusted-fact queue straight from SQL, as the check the
 * repository's own `either` count is measured against.
 *
 * @param dataSource - The suite's data source.
 * @returns How many bottlings carry an untrusted type or country.
 */
async function countUntrustedDirectly(
  dataSource: DataSource,
): Promise<number> {
  return scalar<number>(
    dataSource,
    `SELECT count(*)::int FROM product p
     WHERE (p."typeId" IS NOT NULL AND p."typeSource" = 'llm')
        OR (p."countryId" IS NOT NULL AND p."countrySource" = 'legacy')`,
  );
}

/**
 * Installs the suite's own knowledge base: a parent with two peated child
 * lines, one `auto` row, three withheld rows, one `rejected` row, an alias
 * for each, and the two global peat rules.
 *
 * @param dataSource - The suite's data source.
 * @returns Resolves once the knowledge base is in place.
 */
async function seedKnowledgeBase(dataSource: DataSource): Promise<void> {
  const countryId = await scalar<ID>(
    dataSource,
    `INSERT INTO country (code, "nameUa")
     VALUES ('${TAG.toUpperCase()}', '${TAG} country')
     RETURNING id`,
  );

  await dataSource.query(
    `INSERT INTO producer
       (slug, name, kind, "countryId", region, "defaultTypeName",
        "peatProfile", status)
     SELECT v.slug, v.name, v.kind, $1::uuid, v.region, v.type, v.peat,
            v.status
     FROM (VALUES
       ('${TAG}-parent', '${TAG} Parent', '${ProducerKind.DISTILLERY}',
        'islay', 'single malt', '${PeatProfile.NONE}',
        '${KbStatus.VERIFIED}'),
       ('${TAG}-auto', '${TAG} Auto', '${ProducerKind.DISTILLERY}',
        'speyside', 'single malt', '${PeatProfile.NONE}',
        '${KbStatus.AUTO}'),
       ('${TAG}-rejected', '${TAG} Rejected', '${ProducerKind.BLEND}',
        NULL, NULL, '${PeatProfile.UNKNOWN}', '${KbStatus.REJECTED}'),
       ('${TAG}-withheld-1', '${TAG} Withheld One', '${ProducerKind.BRAND}',
        NULL, NULL, '${PeatProfile.HEAVY}', '${KbStatus.UNVERIFIED}'),
       ('${TAG}-withheld-2', '${TAG} Withheld Two', '${ProducerKind.BRAND}',
        NULL, NULL, '${PeatProfile.HEAVY}', '${KbStatus.UNVERIFIED}'),
       ('${TAG}-withheld-3', '${TAG} Withheld Three',
        '${ProducerKind.BRAND}', NULL, NULL, '${PeatProfile.HEAVY}',
        '${KbStatus.UNVERIFIED}')
     ) AS v(slug, name, kind, region, type, peat, status)`,
    [countryId],
  );

  await dataSource.query(
    `INSERT INTO producer
       (slug, name, kind, "parentId", "peatProfile", status)
     SELECT v.slug, v.name, '${ProducerKind.BRAND}', parent.id,
            '${PeatProfile.HEAVY}', '${KbStatus.VERIFIED}'
     FROM (VALUES
       ('${TAG}-child-a', '${TAG} Child A'),
       ('${TAG}-child-b', '${TAG} Child B')
     ) AS v(slug, name)
     CROSS JOIN producer parent
     WHERE parent.slug = '${TAG}-parent'`,
  );

  await dataSource.query(
    `INSERT INTO producer_alias (key, "producerId", scope)
     SELECT replace(d.slug, '-', ' '), d.id, 'any'
     FROM producer d WHERE d.slug LIKE '${TAG}-%'`,
  );

  await dataSource.query(
    `INSERT INTO flavor_rule (pattern, "matchMode", "peatProfile", priority)
     VALUES ('unpeated', 'word', '${PeatProfile.NONE}', 100),
            ('peated', 'word', '${PeatProfile.HEAVY}', 50)`,
  );
}

/**
 * Installs the suite's own catalogue.
 *
 * Three bottlings carry an untrusted fact — one type, one country, one both —
 * which is what makes the distinct `either` count differ from the sum. The
 * withheld rows are reached by three, two and one bottling respectively, so
 * the queue's ranking has a single correct order.
 *
 * @param dataSource - The suite's data source.
 * @returns Resolves once the catalogue is in place.
 */
async function seedCatalogue(dataSource: DataSource): Promise<void> {
  const typeId = await scalar<ID>(
    dataSource,
    `INSERT INTO type (name) VALUES ('${TAG} type') RETURNING id`,
  );

  const countryId = await scalar<ID>(
    dataSource,
    `SELECT id FROM country WHERE code = '${TAG.toUpperCase()}'`,
  );

  const parentId = await scalar<ID>(
    dataSource,
    `SELECT id FROM producer WHERE slug = '${TAG}-parent'`,
  );

  await dataSource.query(
    `INSERT INTO brand (name)
     SELECT v.name FROM (VALUES
       ('${TAG} Widely Carried'),
       ('${TAG} Plain')
     ) AS v(name)`,
  );

  await dataSource.query(
    `INSERT INTO product
       (name, "brandId", "typeId", "typeSource", "countryId", "countrySource",
        "producerId")
     SELECT v.name, b.id, $1::uuid, v."typeSource", $2::uuid,
            v."countrySource", CASE WHEN v.resolved THEN $3::uuid END
     FROM (VALUES
       ('${TAG} Widely Carried', '${TAG} Widely Carried', 'llm', 'store',
        true),
       ('${TAG} Untrusted Country', '${TAG} Plain', 'store', 'legacy', false),
       ('${TAG} Untrusted Both', '${TAG} Plain', 'llm', 'legacy', false)
     ) AS v(name, brand, "typeSource", "countrySource", resolved)
     LEFT JOIN brand b ON b.name = v.brand`,
    [typeId, countryId, parentId],
  );

  await dataSource.query(
    `INSERT INTO product (name, "brandId")
     SELECT '${TAG} parent Reserve', b.id
     FROM brand b WHERE b.name = '${TAG} Plain'`,
  );

  await seedReachBottlings(dataSource);
  await seedOffers(dataSource);
}

/**
 * Adds the bottlings whose names reach the withheld producers, three for
 * the first, two for the second and one for the third.
 *
 * @param dataSource - The suite's data source.
 * @returns Resolves once they exist.
 */
async function seedReachBottlings(dataSource: DataSource): Promise<void> {
  const names = [1, 2, 3].flatMap((rank) =>
    Array.from(
      { length: WITHHELD + 1 - rank },
      (_, at) => `${TAG} withheld ${rank} Bottling ${at + 1}`,
    )
  );

  await dataSource.query(
    'INSERT INTO product (name) SELECT unnest($1::text[])',
    [names],
  );
}

/**
 * Lists the fixture's bottlings in shops: the widely-carried one in six, one
 * of which lists it twice, and every other bottling in the first shop.
 *
 * @param dataSource - The suite's data source.
 * @returns Resolves once the offers exist.
 */
async function seedOffers(dataSource: DataSource): Promise<void> {
  const slugs = Array.from({ length: SHOPS }, (_, at) => `${TAG}-shop-${at}`);

  await dataSource.query(
    `INSERT INTO store (slug, name, "baseUrl")
     SELECT s, s, 'https://example.invalid/' || s FROM unnest($1::text[]) AS s`,
    [slugs],
  );

  await dataSource.query(
    `INSERT INTO store_product
       (id, "storeId", "productId", sku, url, "nameOrig", "firstSeen",
        "lastSeen", "inStock")
     SELECT uuidv7(), st.id, p.id,
            st.slug || ':' || v.suffix,
            'https://example.invalid/' || st.slug || '/' || v.suffix,
            p.name || v.suffix, DATE '2026-01-01', DATE '2026-01-02', true
     FROM product p
     CROSS JOIN store st
     CROSS JOIN (VALUES (''), (' boxed')) AS v(suffix)
     WHERE p.name = '${TAG} Widely Carried'
       AND st.slug LIKE '${TAG}-shop-%'
       AND (v.suffix = '' OR st.slug = '${TAG}-shop-0')`,
  );

  await dataSource.query(
    `INSERT INTO store_product
       (id, "storeId", "productId", sku, url, "nameOrig", "firstSeen",
        "lastSeen", "inStock")
     SELECT uuidv7(), st.id, p.id, 'sku:' || p.id,
            'https://example.invalid/' || st.slug || '/' || p.id,
            p.name, DATE '2026-01-01', DATE '2026-01-02', true
     FROM product p
     CROSS JOIN store st
     WHERE st.slug = '${TAG}-shop-0'
       AND p.name <> '${TAG} Widely Carried'`,
  );
}
