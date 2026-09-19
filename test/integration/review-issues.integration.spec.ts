import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { REVIEW_SCOTLAND_CODE } from '~constants';
import { CoreProductService } from '~core/product';
import {
  FactSource,
  ProducerAliasScope,
  ProducerKind,
  ProductReviewStatus,
  ReviewIssueCode,
  ReviewQueueStatus,
} from '~enums';
import type {
  ID,
  ReviewInertHitIds,
  ReviewIssueCounts,
  ReviewQueueRow,
} from '~types';

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
 * failure message.
 */
const TAG = 'itri';

/**
 * Whether a detector fires on nothing when nothing is wrong. The suite seeds
 * one bottling per code and one that is clean, so this is the control.
 */
interface IssuesFixture {
  /**
   * Every open row, keyed by the name the fixture gave it.
   */
  byName: Map<string, ReviewQueueRow>;

  /**
   * The whole open queue, so membership can be asserted.
   */
  open: ReviewQueueRow[];

  /**
   * The counters over the same fixture.
   */
  counts: ReviewIssueCounts;

  /**
   * The queue filtered to one code.
   */
  filtered: ReviewQueueRow[];

  /**
   * The decisions log.
   */
  rejected: ReviewQueueRow[];

  /**
   * The queue with acknowledged contradictions counted too.
   */
  withAcknowledged: ReviewQueueRow[];
}

describe('curation queue: the detectors', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let fixture: IssuesFixture;

  /**
   * Inserts one bottling and, unless told otherwise, one stocked offer for it.
   *
   * @param name - The canonical name, which doubles as the case's label.
   * @param columns - Column overrides, as SQL fragments keyed by column.
   * @param offer - The raw name the shop uses, or null for no offer at all.
   * @returns The bottling's id.
   */
  async function seedProduct(
    name: string | null,
    columns: Record<string, unknown> = {},
    offer: string | null = 'raw name',
  ): Promise<ID> {
    const base: Record<string, unknown> = {
      name,
      abv: 40,
      abvSource: FactSource.STORE,
      volumeMl: 700,
      volumeSource: FactSource.STORE,
      typeSource: FactSource.KB,
      countrySource: FactSource.KB,
      producerId: livedProducer,
      producerSource: FactSource.KB,
      reviewStatus: null,
      ...columns,
    };

    const keys = Object.keys(base);
    const holes = keys.map((_, at) => `$${at + 1}`).join(', ');

    const [row] = await dataSource.query(
      `INSERT INTO product (${keys.map((k) => `"${k}"`).join(', ')})
       VALUES (${holes}) RETURNING id`,
      keys.map((key) => base[key]),
    ) as { id: ID }[];

    if (offer !== null) {
      await dataSource.query(
        `INSERT INTO store_product
           ("storeId", "productId", sku, url, "nameOrig", "inStock",
            "firstSeen", "lastSeen")
         VALUES ($1, $2, $3, $4, $5, true, CURRENT_DATE, CURRENT_DATE)`,
        [
          await storeId(),
          row.id,
          `${TAG}-${row.id}`,
          `https://example.test/${row.id}`,
          offer,
        ],
      );
    }

    return row.id;
  }

  /**
   * The one shop every fixture offer belongs to, created on first use.
   *
   * @returns The store's id.
   */
  async function storeId(): Promise<ID> {
    const [row] = await dataSource.query(
      `INSERT INTO store (slug, name, "baseUrl", active)
       VALUES ($1, $1, 'https://example.test', true)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [`${TAG}-shop`],
    ) as { id: ID }[];

    return row.id;
  }

  /**
   * Resolves a lookup row's id by its natural key.
   *
   * @param table - `type` or `country`.
   * @param column - The column holding the key.
   * @param value - The key.
   * @returns The id, or null when the lookup has no such row.
   */
  async function lookupId(
    table: string,
    column: string,
    value: string,
  ): Promise<ID | null> {
    const rows = await dataSource.query(
      `SELECT id FROM ${table} WHERE "${column}" = $1`,
      [value],
    ) as { id: ID }[];

    return rows[0]?.id ?? null;
  }

  /**
   * The producer every clean fixture row resolves to, so `no-producer` fires
   * only where a case means it to.
   */
  let livedProducer: ID;

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();
    dataSource = moduleRef.get(DataSource);

    const products = moduleRef.get(CoreProductService);

    fixture = await withRolledBackFixture(async () => {
      await clearCatalogue(dataSource);
      await clearKnowledgeBase(dataSource);

      const singleMalt = await lookupId('type', 'name', 'single malt');
      const blend = await lookupId('type', 'name', 'blend');
      const scotland = await lookupId('country', 'code', 'GB-SCT');
      const england = await lookupId('country', 'code', 'GB-ENG');

      const [live] = await dataSource.query(
        `INSERT INTO producer (slug, name, kind, status, "peatProfile")
         VALUES ($1, 'Fixture Distillery', $2, 'verified', 'none')
         RETURNING id`,
        [`${TAG}-live`, ProducerKind.DISTILLERY],
      ) as { id: ID }[];

      livedProducer = live.id;

      const [rejectedProducer] = await dataSource.query(
        `INSERT INTO producer (slug, name, kind, status, "peatProfile")
         VALUES ($1, 'Yakusun', $2, 'rejected', 'unknown') RETURNING id`,
        [`${TAG}-yakusun`, ProducerKind.BLEND],
      ) as { id: ID }[];

      await dataSource.query(
        `INSERT INTO producer_alias (key, "producerId", scope)
         VALUES ('yakusun', $1, $2)`,
        [rejectedProducer.id, ProducerAliasScope.ANY],
      );

      const clean = await seedProduct('Clean Malt', {
        typeId: singleMalt,
        countryId: scotland,
      });

      await seedProduct('Brand New', {
        typeId: singleMalt,
        countryId: scotland,
        reviewStatus: ProductReviewStatus.PENDING,
      });

      await seedProduct('Yakusun Classic', {
        typeId: singleMalt,
        countryId: scotland,
        producerId: null,
        producerSource: null,
      }, 'Yakusun Classic Blend');

      await seedProduct('Джек Деніелс', {
        typeId: singleMalt,
        countryId: scotland,
      });

      await seedProduct('Twin Malt', {
        typeId: singleMalt,
        countryId: scotland,
      });

      await seedProduct('Twin Malt', {
        typeId: singleMalt,
        countryId: scotland,
      });

      await seedProduct('No Abv', {
        abv: null,
        typeId: singleMalt,
        countryId: scotland,
      });

      await seedProduct('No Volume', {
        volumeMl: null,
        typeId: singleMalt,
        countryId: scotland,
      });

      await seedProduct('No Country', { typeId: singleMalt, countryId: null });
      await seedProduct('No Type', { typeId: null, countryId: scotland });

      await seedProduct(
        'Rye Named',
        {
          typeId: blend,
          typeSource: FactSource.STORE,
          countryId: scotland,
        },
        'Straight Rye Whiskey',
      );

      await seedProduct(
        'Cask Rye',
        {
          typeId: blend,
          typeSource: FactSource.STORE,
          countryId: scotland,
        },
        'Dopplebock Rye Cask Finish',
      );

      await seedProduct(
        'Islay Blend',
        {
          typeId: singleMalt,
          countryId: england,
          countrySource: FactSource.STORE,
        },
        'Islay Single Malt',
      );

      await seedProduct('Liqueur', {
        abv: 30,
        abvSource: FactSource.STORE,
        typeId: singleMalt,
        countryId: scotland,
      });

      await seedProduct('Gift Malt у коробці', {
        typeId: singleMalt,
        countryId: scotland,
      });

      await seedProduct(
        'Aged Malt',
        { age: null, typeId: singleMalt, countryId: scotland },
        'Aged Malt 12 років',
      );

      await seedProduct('Single Store Age', {
        age: 4,
        ageSource: FactSource.STORE,
        typeId: singleMalt,
        countryId: scotland,
      });

      await seedProduct('Guessed Type', {
        typeId: singleMalt,
        typeSource: FactSource.LLM,
        countryId: scotland,
      });

      const conflicted = await seedProduct('Contested Abv', {
        typeId: singleMalt,
        countryId: scotland,
      });

      await dataSource.query(
        `INSERT INTO product_fact_conflict
           ("productId", "storeId", attribute, "storedValue", "claimedValue",
            "storedSource", "seenCount", "lastSeenAt")
         VALUES ($1, $2, 'abv', '42', '40', 'name', 3, now())`,
        [conflicted, await storeId()],
      );

      const acknowledged = await seedProduct('Settled Abv', {
        typeId: singleMalt,
        countryId: scotland,
      });

      await dataSource.query(
        `INSERT INTO product_fact_conflict
           ("productId", "storeId", attribute, "storedValue", "claimedValue",
            "storedSource", "seenCount", "lastSeenAt", "resolvedAt")
         VALUES ($1, $2, 'abv', '43', '40', 'name', 1, now(), now())`,
        [acknowledged, await storeId()],
      );

      const notWhisky = await seedProduct('Ruled Out', {
        typeId: singleMalt,
        countryId: scotland,
        reviewStatus: ProductReviewStatus.REJECTED,
      });

      const hits: ReviewInertHitIds = {
        rejected: [],
        withheld: [],
      };

      const resolved = await products.findUnresolvedNames();
      const yakusun = resolved.find((row) => row.name === 'Yakusun Classic');

      if (yakusun) {
        hits.rejected.push(yakusun.id);
      }

      const [open, counts, filtered, decisions, acknowledgedPage] =
        await Promise.all([
          products.findReviewQueue({ perPage: 100 }, hits),
          products.countReviewIssues(hits),
          products.findReviewQueue(
            { perPage: 100, issue: [ReviewIssueCode.MISSING_ABV] },
            hits,
          ),
          products.findReviewQueue(
            { perPage: 100, status: ReviewQueueStatus.REJECTED },
            hits,
          ),
          products.findReviewQueue(
            { perPage: 100, includeAcknowledged: true },
            hits,
          ),
        ]);

      expect(clean).toBeDefined();
      expect(notWhisky).toBeDefined();

      return {
        byName: new Map(
          open.rows.map((row) => [row.name ?? '', row]),
        ),
        open: open.rows,
        counts,
        filtered: filtered.rows,
        rejected: decisions.rows,
        withAcknowledged: acknowledgedPage.rows,
      };
    });
  });

  afterAll(async () => {
    await closeIntegrationModule(moduleRef);
  });

  /**
   * The codes one fixture row carries.
   *
   * @param name - The bottling's name.
   * @returns Its codes, sorted so an assertion reads the same way twice.
   */
  function codesOf(name: string): string[] {
    return (fixture.byName.get(name)?.issues ?? [])
      .map((issue) => issue.code)
      .sort();
  }

  it('leaves a clean verified bottling out of the queue', () => {
    expect(fixture.byName.has('Clean Malt')).toBe(false);
    expect(fixture.byName.has('Ruled Out')).toBe(false);
  });

  it('queues a pending bottling on nothing but its newness', () => {
    expect(codesOf('Brand New')).toEqual([ReviewIssueCode.NEW]);
  });

  it('names a bottling that reaches a producer somebody ruled out', () => {
    expect(codesOf('Yakusun Classic')).toContain(
      ReviewIssueCode.PRODUCER_REJECTED,
    );
  });

  it('flags a name carrying no Latin letter', () => {
    expect(codesOf('Джек Деніелс')).toContain(ReviewIssueCode.CYRILLIC_NAME);
  });

  it('flags both halves of an identity twin', () => {
    const twins = fixture.open.filter((row) => row.name === 'Twin Malt');

    expect(twins).toHaveLength(2);
    twins.forEach((row) => {
      expect(row.issues.map((issue) => issue.code))
        .toContain(ReviewIssueCode.DUPLICATE);
    });
  });

  it('flags each missing fact under its own code', () => {
    expect(codesOf('No Abv')).toContain(ReviewIssueCode.MISSING_ABV);
    expect(codesOf('No Volume')).toContain(ReviewIssueCode.MISSING_VOLUME);
    expect(codesOf('No Country')).toContain(ReviewIssueCode.MISSING_COUNTRY);
    expect(codesOf('No Type')).toContain(ReviewIssueCode.MISSING_TYPE);
  });

  it('reads a type word out of the raw name and says which', () => {
    const issue = fixture.byName.get('Rye Named')?.issues
      .find((one) => one.code === ReviewIssueCode.TYPE_VS_NAME);

    expect(issue?.detail).toBe('rye');
    expect(issue?.field).toBe('type');
  });

  it('never reads a cask qualifier as a category claim', () => {
    expect(codesOf('Cask Rye')).not.toContain(ReviewIssueCode.TYPE_VS_NAME);
  });

  it('flags a Scotch region word against a different country', () => {
    expect(codesOf('Islay Blend')).toContain(ReviewIssueCode.COUNTRY_VS_NAME);
  });

  it('names the country that region word means', () => {
    /**
     * The detector fires on Scotland's regions and on nothing else, so the
     * country is a constant — and the screen offers it as the one-click fix.
     * Stating it here is what keeps that vocabulary on this side: without it
     * the client would carry its own copy of «Islay means Scotland».
     */
    const issue = fixture.byName.get('Islay Blend')?.issues
      .find((one) => one.code === ReviewIssueCode.COUNTRY_VS_NAME);

    expect(issue?.detail).toBe(REVIEW_SCOTLAND_CODE);
    expect(issue?.field).toBe('country');
  });

  it('flags a strength outside the whisky band', () => {
    expect(codesOf('Liqueur')).toContain(ReviewIssueCode.ABV_RANGE);
  });

  it('flags packaging left in the canonical name', () => {
    expect(codesOf('Gift Malt у коробці'))
      .toContain(ReviewIssueCode.NAME_LEFTOVER);
  });

  it('flags an age a shop states and the bottling does not carry', () => {
    expect(codesOf('Aged Malt')).toContain(ReviewIssueCode.AGE_IN_RAW);
  });

  it('flags an age only one shop states', () => {
    expect(codesOf('Single Store Age'))
      .toContain(ReviewIssueCode.AGE_SINGLE_STORE);
  });

  it('flags a fact the filters distrust', () => {
    expect(codesOf('Guessed Type')).toContain(ReviewIssueCode.UNTRUSTED_FACT);
  });

  it('queues an open contradiction and carries its claim', () => {
    const row = fixture.byName.get('Contested Abv');

    expect(row?.issues.map((one) => one.code))
      .toContain(ReviewIssueCode.CONFLICT);
    expect(row?.conflicts[0]?.claimed).toBe('40');
    expect(row?.conflicts[0]?.stored).toBe('42');
  });

  it('leaves an acknowledged contradiction out until asked for', () => {
    expect(fixture.byName.has('Settled Abv')).toBe(false);
    expect(
      fixture.withAcknowledged.some((row) => row.name === 'Settled Abv'),
    ).toBe(true);
  });

  it('counts each code exactly as the page filtered by it lists', () => {
    expect(fixture.counts.byIssue[ReviewIssueCode.MISSING_ABV])
      .toBe(fixture.filtered.length);
    expect(
      fixture.filtered.every((row) =>
        row.issues.some((one) => one.code === ReviewIssueCode.MISSING_ABV)
      ),
    ).toBe(true);
  });

  it('counts the open queue as the page returns it', () => {
    expect(fixture.counts.open).toBe(fixture.open.length);
  });

  it('answers the rejected slice with the decisions log', () => {
    expect(fixture.rejected.map((row) => row.name)).toEqual(['Ruled Out']);
  });

  it('carries the evidence a decision is made from', () => {
    const row = fixture.byName.get('Rye Named');

    expect(row?.offers).toHaveLength(1);
    expect(row?.offers[0]?.nameOrig).toBe('Straight Rye Whiskey');
    expect(row?.offers[0]?.inStock).toBe(true);
  });

  it('reads the trademark token a shop hides in a raw name', () => {
    expect(
      fixture.byName.get('Yakusun Classic')?.offers[0]?.brandHint,
    ).toBeNull();
  });
});
