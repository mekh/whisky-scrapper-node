import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CoreFlavorService } from '~core/flavor';
import { CoreProducerService } from '~core/producer';
import { CoreProductService } from '~core/product';
import {
  KbStatus,
  PeatProfile,
  ProducerIssueCode,
  ProducerKind,
  ReviewIssueSeverity,
} from '~enums';
import { VersionedCacheService } from '~lib/cache';
import { ValkeyService } from '~lib/valkey';
import {
  KbApplyService,
  KbReconcileService,
  KbResolverService,
} from '~scrape/kb';
import type {
  ID,
  KbAliasEntry,
  ProducerDetail,
  ProducerQueueRow,
  ProducerReviewRow,
  ReviewProducerSummary,
  TypePaginated,
} from '~types';

import type { KbReconcileRun } from '../../src/scrape/kb/kb.interfaces';

import { ProducerReachService } from '../../src/domain/product/producer-reach.service';
import {
  ProducerReviewService,
} from '../../src/domain/product/producer-review.service';
import { ProducerRuleFactory } from '../../src/domain/product/producer-rule.factory';

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
  withheldPage: TypePaginated<ProducerQueueRow>;

  /**
   * The `auto` tab.
   */
  autoPage: TypePaginated<ProducerQueueRow>;

  /**
   * The `verified` tab.
   */
  verifiedPage: TypePaginated<ProducerQueueRow>;

  /**
   * Every withheld row, unpaged, as the listing returns it.
   */
  fullUnverified: { rows: ProducerReviewRow[]; total: number };

  /**
   * The rejected producers' own count, read straight from SQL.
   */
  rejectedCount: number;

  /**
   * The producers queue's counters.
   */
  summary: ReviewProducerSummary;

  /**
   * Ids of the producers the fixture rejected.
   */
  rejectedIds: ID[];

  /**
   * The resolver's own alias index.
   */
  aliasIndex: KbAliasEntry[];

  /**
   * The producers queue, every status.
   */
  queuePage: TypePaginated<ProducerQueueRow>;

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
      {
        bumpAfterCommit: (): void => undefined,
      } as unknown as VersionedCacheService,
      {
        getClient: () => ({
          get: async (): Promise<string | null> => null,
          set: async (): Promise<void> => undefined,
        }),
      } as unknown as ValkeyService,
    );

    const review = new ProducerReviewService(
      producers,
      products,
      new ProducerRuleFactory(
        moduleRef.get(CoreFlavorService, { strict: false }),
      ),
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
        queuePage: await review.queue({ page: 1, perPage: 50 }),
        withheldPage: await review.queue({
          status: KbStatus.UNVERIFIED,
          page: 1,
          perPage: 20,
        }),
        autoPage: await review.queue({
          status: KbStatus.AUTO,
          page: 1,
          perPage: 20,
        }),
        verifiedPage: await review.queue({
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
        rejectedCount: rejected.length,
        aliasIndex: await producers.loadAliasIndex(),
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
   * A live producer is queued only for a reason. The `auto` slice holds
   * exactly the row with no alias — the one `${TAG}-auto`, complete in every
   * field, is absent, which is the difference between this and the old
   * screen's first tab, a listing of every row by status. `potentialReach` is
   * null on the live slices for the same reason it exists on the withheld
   * one: there `productCount` is already a real answer.
   */
  it('queues a live producer only when a detector fires', () => {
    expect(fixture.autoPage.data.map((row) => row.slug))
      .toEqual([`${TAG}-no-alias`]);

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
    expect(fixture.rejectedCount).toBe(1);

    expect(fixture.queuePage.data.map((row) => row.id))
      .not.toContain(fixture.rejectedIds[0]);

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
   * The producers queue exists because nothing listed a producer with a real
   * problem: 0 rows are `unverified` today, so the old screen's first tab was
   * empty while the 18 with no alias and the 8 whose every spelling is
   * unreachable were invisible. The fixture plants one of each.
   */
  it('queues a producer nothing can ever resolve to', () => {
    const noAlias = fixture.queuePage.data.find(
      (row) => row.slug === `${TAG}-no-alias`,
    );

    expect(noAlias).toBeDefined();
    expect(noAlias?.aliasCount).toBe(0);
    expect(noAlias?.issues.map((issue) => issue.code))
      .toContain(ProducerIssueCode.NO_ALIAS);
  });

  /**
   * Every code the queue reports carries the severity the client colours its
   * chips by, from the one map both sides read.
   */
  it('explains every code with a severity', () => {
    const codes = fixture.queuePage.data.flatMap((row) => row.issues);

    expect(codes.length).toBeGreaterThan(0);

    codes.forEach((issue) => {
      expect(Object.values(ReviewIssueSeverity)).toContain(issue.severity);
    });
  });

  /**
   * The counters and the page have to be the same statement's answer, or a
   * chip opens a page that contradicts the number on it.
   */
  it('counts the queue exactly as the page lists it', () => {
    expect(fixture.summary.open).toBe(fixture.queuePage.total);

    const tallied = fixture.queuePage.data
      .filter((row) =>
        row.issues.some((issue) => issue.code === ProducerIssueCode.NO_ALIAS)
      ).length;

    expect(fixture.summary.byIssue[ProducerIssueCode.NO_ALIAS])
      .toBe(tallied);
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
        '${KbStatus.UNVERIFIED}'),
       ('${TAG}-no-alias', '${TAG} No Alias', '${ProducerKind.DISTILLERY}',
        'speyside', 'single malt', '${PeatProfile.NONE}',
        '${KbStatus.AUTO}')
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
     FROM producer d
     WHERE d.slug LIKE '${TAG}-%' AND d.slug <> '${TAG}-no-alias'`,
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
    `INSERT INTO product
       (name, "brandOrig", "typeId", "typeSource", "countryId",
        "countrySource", "producerId")
     SELECT v.name, v.brand, $1::uuid, v."typeSource", $2::uuid,
            v."countrySource", CASE WHEN v.resolved THEN $3::uuid END
     FROM (VALUES
       ('${TAG} Widely Carried', '${TAG} Widely Carried', 'llm', 'store',
        true),
       ('${TAG} Untrusted Country', '${TAG} Plain', 'store', 'legacy', false),
       ('${TAG} Untrusted Both', '${TAG} Plain', 'llm', 'legacy', false)
     ) AS v(name, brand, "typeSource", "countrySource", resolved)`,
    [typeId, countryId, parentId],
  );

  await dataSource.query(
    `INSERT INTO product (name, "brandOrig")
     VALUES ('${TAG} parent Reserve', '${TAG} Plain')`,
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
