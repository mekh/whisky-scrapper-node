import { TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { CoreCountryService } from '~core/country';
import { CoreFlavorService } from '~core/flavor';
import { CoreProducerService } from '~core/producer';
import { CoreProductService } from '~core/product';
import { CoreStoreProductService } from '~core/store-product';
import { CoreTypeService } from '~core/type';
import {
  FactSource,
  KbStatus,
  PeatProfile,
  ProducerAliasScope,
  ProducerKind,
  ProductReviewStatus,
} from '~enums';
import { VersionedCacheService } from '~lib/cache';
import { ValkeyService } from '~lib/valkey';
import {
  KbApplyService,
  KbReconcileService,
  KbResolverService,
} from '~scrape/kb';
import type { ID, ReviewCommitResult, ReviewPreview } from '~types';

import { ProductService } from '../../src/domain/product/product.service';
import {
  ReviewCommitService,
} from '../../src/domain/product/review-commit.service';
import {
  ReviewPreviewService,
} from '../../src/domain/product/review-preview.service';

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
 * Prefix on every row this suite writes.
 */
const TAG = 'itrc';

/**
 * How many bottlings the fixture gives the unreachable maker. Deliberately
 * more than one, since the whole point of an alias over a pin is that it
 * reaches them all.
 */
const HYDE_BOTTLINGS = 3;

/**
 * How many bottlings the bulk verdict is given. More than two, because two is
 * exactly what a mis-read `UPDATE ... RETURNING` answers for any batch.
 */
const BULK_BOTTLINGS = 4;

/**
 * Everything the assertions read, gathered while the fixture transaction is
 * still open.
 */
interface CommitFixture {
  /**
   * What a `lead`-scoped alias for the short maker would do.
   */
  leadPreview: ReviewPreview;

  /**
   * What the same spelling would do at each scope.
   */
  scopes: Record<string, { frees: number; steals: number }>;

  /**
   * What a spelling that outranks an existing one would do.
   */
  stealPreview: ReviewPreview;

  /**
   * What committing the alias reported.
   */
  aliasCommit: ReviewCommitResult;

  /**
   * How many bottlings resolve to the short maker after the commit.
   */
  resolvedAfter: number;

  /**
   * The facts of the bottling a commit patched and confirmed.
   */
  patched: {
    abv: number | null;
    abvSource: string | null;
    typeSource: string | null;
    reviewStatus: string | null;
  };

  /**
   * Whether the bottling's contradictions were acknowledged.
   */
  openConflicts: number;

  /**
   * What committing a pin reported.
   */
  pinCommit: ReviewCommitResult;

  /**
   * The pinned bottling's link after a full knowledge-base pass.
   */
  pinnedAfterReconcile: { producerId: ID | null; producerSource: string };

  /**
   * Why pinning a bottler into the producer slot was refused.
   */
  bottlerRefusal: string | null;

  /**
   * How many rows a bulk verdict over {@link BULK_BOTTLINGS} reported, and
   * how many it really wrote.
   */
  bulkVerdict: { reported: number; written: number };
}

describe('the curation commit (integration)', () => {
  let moduleRef: TestingModule;
  let fixture: CommitFixture;

  beforeAll(async () => {
    moduleRef = await bootIntegrationModule();

    const dataSource = moduleRef.get(DataSource);
    const producers = moduleRef.get(CoreProducerService, { strict: false });
    const products = moduleRef.get(CoreProductService, { strict: false });
    const offers = moduleRef.get(CoreStoreProductService, { strict: false });
    const countries = moduleRef.get(CoreCountryService, { strict: false });
    const types = moduleRef.get(CoreTypeService, { strict: false });
    const flavors = moduleRef.get(CoreFlavorService, { strict: false });

    const cache = {
      bumpAfterCommit: (): void => undefined,
    } as unknown as VersionedCacheService;

    const valkey = {
      getClient: () => ({
        get: async (): Promise<string | null> => null,
        set: async (): Promise<void> => undefined,
      }),
    } as unknown as ValkeyService;

    const resolver = new KbResolverService();
    const reconcile = new KbReconcileService(
      producers,
      products,
      new KbApplyService(resolver),
      cache,
      valkey,
    );

    const preview = new ReviewPreviewService(
      producers,
      products,
      new KbApplyService(resolver),
    );

    const productService = new ProductService(
      products,
      offers,
      countries,
      types,
      flavors,
      cache,
    );

    const commit = new ReviewCommitService(
      products,
      producers,
      productService,
      preview,
      reconcile,
      cache,
    );

    /**
     * Inserts one bottling with one stocked offer.
     *
     * @param name - The canonical name.
     * @param columns - Column overrides.
     * @returns The bottling's id.
     */
    async function seedProduct(
      name: string,
      columns: Record<string, unknown> = {},
    ): Promise<ID> {
      const base: Record<string, unknown> = {
        name,
        abv: 40,
        volumeMl: 700,
        reviewStatus: ProductReviewStatus.PENDING,
        ...columns,
      };

      const keys = Object.keys(base);
      const holes = keys.map((_, at) => `$${at + 1}`).join(', ');

      const [row] = await dataSource.query(
        `INSERT INTO product (${keys.map((k) => `"${k}"`).join(', ')})
         VALUES (${holes}) RETURNING id`,
        keys.map((key) => base[key]),
      ) as { id: ID }[];

      await dataSource.query(
        `INSERT INTO store_product
           ("storeId", "productId", sku, url, "nameOrig", "inStock",
            "firstSeen", "lastSeen")
         SELECT s.id, $1, $2, $3, $4, true, CURRENT_DATE, CURRENT_DATE
         FROM store s WHERE s.slug = $5`,
        [
          row.id,
          `${TAG}-${row.id}`,
          `https://x.test/${row.id}`,
          name,
          `${TAG}-shop`,
        ],
      );

      return row.id;
    }

    fixture = await withRolledBackFixture(async () => {
      await clearCatalogue(dataSource);
      await clearKnowledgeBase(dataSource);

      await dataSource.query(
        `INSERT INTO store (slug, name, "baseUrl", active)
         VALUES ($1, $1, 'https://x.test', true)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`,
        [`${TAG}-shop`],
      );

      const [hyde] = await dataSource.query(
        `INSERT INTO producer (slug, name, kind, status, "peatProfile")
         VALUES ($1, 'Hyde', $2, $3, $4) RETURNING id`,
        [
          `${TAG}-hyde`,
          ProducerKind.BRAND,
          KbStatus.VERIFIED,
          PeatProfile.NONE,
        ],
      ) as { id: ID }[];

      const [walker] = await dataSource.query(
        `INSERT INTO producer (slug, name, kind, status, "peatProfile")
         VALUES ($1, 'Johnnie Walker', $2, $3, $4) RETURNING id`,
        [
          `${TAG}-walker`,
          ProducerKind.BLEND,
          KbStatus.VERIFIED,
          PeatProfile.NONE,
        ],
      ) as { id: ID }[];

      const [laing] = await dataSource.query(
        `INSERT INTO producer (slug, name, kind, status, "peatProfile")
         VALUES ($1, 'Douglas Laing', $2, $3, $4) RETURNING id`,
        [
          `${TAG}-laing`,
          ProducerKind.BOTTLER,
          KbStatus.VERIFIED,
          PeatProfile.UNKNOWN,
        ],
      ) as { id: ID }[];

      await dataSource.query(
        `INSERT INTO producer_alias (key, "producerId", scope)
         VALUES ('hyde', $1, $2), ('walker', $3, $4)`,
        [hyde.id, ProducerAliasScope.BRAND, walker.id, ProducerAliasScope.ANY],
      );

      const open = await seedProduct('Hyde 6 Special Reserve');

      await seedProduct('Hyde 3 Bourbon Cask');
      await seedProduct('Hyde 7 Sherry Cask');

      /**
       * The bottling a wider spelling would take away: it resolves to another
       * producer today, through a shorter alias that a longer one outranks.
       */
      const owned = await seedProduct('Walker Black Label');

      /**
       * The baseline every reach number is measured against is what the
       * catalogue **holds**, so the fixture resolves it first. Without this
       * every bottling would read as freed, since they would all start from
       * no producer at all.
       */
      await reconcile.run();

      const link = {
        mode: 'alias' as const,
        producerId: hyde.id,
        spelling: 'hyde',
      };

      const leadPreview = await preview.previewLink(open, {
        ...link,
        scope: ProducerAliasScope.LEAD,
      });

      const stealPreview = await preview.previewLink(owned, {
        mode: 'alias' as const,
        producerId: hyde.id,
        spelling: 'walker black',
        scope: ProducerAliasScope.ANY,
      });

      /**
       * The producer card asks the same question with no bottling in focus
       * — the number on «→ на початку назви» — and must get the same answer
       * the binding block gets, or the two screens would number one action
       * differently.
       */
      const [hydeAlias] = await dataSource.query(
        'SELECT id FROM producer_alias WHERE key = $1',
        ['hyde'],
      ) as { id: ID }[];

      if (!hydeAlias) {
        throw new Error('the fixture inserted no hyde alias');
      }

      const cardPreview = await preview.previewAliasRescope(
        hyde.id,
        hydeAlias.id,
        ProducerAliasScope.LEAD,
      );

      expect(cardPreview.reach).toEqual(leadPreview.reach);
      expect(cardPreview.affectedTotal).toBe(leadPreview.affectedTotal);

      const aliasCommit = await commit.commit({
        productId: open,
        verdict: ProductReviewStatus.VERIFIED,
        producer: { ...link, scope: ProducerAliasScope.LEAD },
      });

      const resolvedAfter = await dataSource.query(
        'SELECT count(*)::int AS n FROM product WHERE "producerId" = $1',
        [hyde.id],
      ) as { n: number }[];

      const edited = await seedProduct('Needs Facts', { abv: null });

      await dataSource.query(
        `INSERT INTO product_fact_conflict
           ("productId", "storeId", attribute, "storedValue", "claimedValue",
            "storedSource", "seenCount", "lastSeenAt")
         SELECT $1, s.id, 'abv', '42', '40', 'name', 3, now()
         FROM store s WHERE s.slug = $2`,
        [edited, `${TAG}-shop`],
      );

      await commit.commit({
        productId: edited,
        verdict: ProductReviewStatus.VERIFIED,
        patch: { abv: 43 },
        confirm: ['type'],
      });

      const [patched] = await dataSource.query(
        `SELECT abv, "abvSource", "typeSource", "reviewStatus"
         FROM product WHERE id = $1`,
        [edited],
      ) as {
        abv: number | null;
        abvSource: string | null;
        typeSource: string | null;
        reviewStatus: string | null;
      }[];

      const [conflicts] = await dataSource.query(
        `SELECT count(*)::int AS n FROM product_fact_conflict
         WHERE "productId" = $1 AND "resolvedAt" IS NULL`,
        [edited],
      ) as { n: number }[];

      const pinned = await seedProduct('Nothing Reaches This');

      const pinCommit = await commit.commit({
        productId: pinned,
        verdict: ProductReviewStatus.VERIFIED,
        producer: { mode: 'pin', producerId: walker.id },
      });

      await reconcile.run();

      const [pinnedRow] = await dataSource.query(
        'SELECT "producerId", "producerSource" FROM product WHERE id = $1',
        [pinned],
      ) as { producerId: ID | null; producerSource: string }[];

      /**
       * A bottler in the producer slot, which the resolver refuses outright:
       * the facts would then be read off a company that owns no still.
       */
      let bottlerRefusal: string | null = null;

      try {
        await commit.commit({
          productId: pinned,
          verdict: ProductReviewStatus.VERIFIED,
          producer: { mode: 'pin', producerId: laing.id },
        });
      } catch (error) {
        bottlerRefusal = (error as Error).message;
      }

      /**
       * A batch big enough to tell a real count from the driver's
       * `[rows, affected]` envelope, whose length is 2 whatever was written.
       */
      const batch: ID[] = [];

      for (let at = 0; at < BULK_BOTTLINGS; at += 1) {
        batch.push(await seedProduct(`Bulk Verdict ${at}`));
      }

      const reported = await products.applyReviewStatus(
        batch,
        ProductReviewStatus.VERIFIED,
      );

      const [written] = await dataSource.query(
        `SELECT count(*)::int AS n FROM product
         WHERE id = ANY($1::uuid[]) AND "reviewStatus" = $2`,
        [batch, ProductReviewStatus.VERIFIED],
      ) as { n: number }[];

      return {
        bulkVerdict: { reported, written: written?.n ?? 0 },
        leadPreview,
        stealPreview,
        scopes: leadPreview.aliasScopes ?? {},
        aliasCommit,
        resolvedAfter: resolvedAfter[0]?.n ?? 0,
        patched,
        openConflicts: conflicts?.n ?? 0,
        pinCommit,
        pinnedAfterReconcile: pinnedRow,
        bottlerRefusal,
      };
    });
  });

  afterAll(async () => {
    await closeIntegrationModule(moduleRef);
  });

  /**
   * The `Hyde` case, which is why the `lead` scope exists: a four-letter
   * maker can only be brand-scoped, so a shop that states no brand leaves
   * every bottling of it unresolved. Anchoring at the start of the name is
   * what makes the exemption safe — the same word anywhere in the name takes
   * a bottling that belongs to somebody else.
   */
  it('states what each alias scope would free', () => {
    expect(fixture.scopes.lead?.frees).toBe(HYDE_BOTTLINGS);
    expect(fixture.scopes.lead?.steals).toBe(0);

    /**
     * The measurement that makes the `lead` scope worth having: `any` frees
     * nothing here, because a four-letter spelling is below the substring
     * floor and the resolver refuses to look for it inside a name at all.
     * `brand` frees nothing either — the shop states no brand — so before
     * `lead` existed these bottlings were unreachable by any scope.
     */
    expect(fixture.scopes.any?.frees).toBe(0);
    expect(fixture.scopes.brand?.frees).toBe(0);
  });

  /**
   * The danger number, and the reason the binding block states two rather
   * than one: a spelling that outranks an existing alias takes a bottling
   * away from the producer it belongs to. A bottling gaining its first
   * producer is never counted here.
   */
  it('counts a bottling taken from another producer separately', () => {
    expect(fixture.stealPreview.reach.steals).toBe(1);
    expect(fixture.stealPreview.reach.frees).toBe(0);
    expect(fixture.stealPreview.affected[0]?.changes.producer)
      .toEqual({ from: 'Johnnie Walker', to: 'Hyde' });
  });

  it('names the bottlings the action would move', () => {
    expect(fixture.leadPreview.affectedTotal).toBe(HYDE_BOTTLINGS);

    fixture.leadPreview.affected.forEach((one) => {
      expect(one.changes.producer?.to).toBe('Hyde');
    });
  });

  /**
   * The commit's whole reason for being: one alias takes every bottling
   * carrying the spelling out of the queue, not just the one on screen.
   */
  it('applies the alias to the whole catalogue in the same request', () => {
    expect(fixture.resolvedAfter).toBe(HYDE_BOTTLINGS);
    expect(fixture.aliasCommit.affectedTotal).toBe(HYDE_BOTTLINGS);
    expect(fixture.aliasCommit.issuesLeft)
      .not.toContain('no-producer');
  });

  /**
   * Every fact a person writes or confirms is stamped `manual`, which is what
   * makes the decision durable: every automatic pass is gated on it.
   */
  it('stamps what it writes and what it confirms', () => {
    expect(fixture.patched.abv).toBe(43);
    expect(fixture.patched.abvSource).toBe(FactSource.MANUAL);
    expect(fixture.patched.typeSource).toBe(FactSource.MANUAL);
    expect(fixture.patched.reviewStatus)
      .toBe(ProductReviewStatus.VERIFIED);
  });

  /**
   * A verdict settles the bottling, so it settles the claims against it —
   * which is what the old "Вирішено" button lacked.
   */
  it('acknowledges the bottling’s open contradictions', () => {
    expect(fixture.openConflicts).toBe(0);
  });

  /**
   * The new write path. `SET_PRODUCERS_SQL` has always respected a `manual`
   * link and nothing could write one, so a bottling no spelling reaches had
   * no way to be given a maker at all.
   */
  /**
   * The count a bulk verdict reports is the number the toast shows, and the
   * driver answers an `UPDATE ... RETURNING` with `[rows, affected]` — so a
   * raw `length` reads **2** for every batch that matched anything. It
   * shipped once as "записано рядків: 2" on a verdict that wrote thirteen.
   */
  it('reports the number of rows a bulk verdict really wrote', () => {
    expect(fixture.bulkVerdict.written).toBe(BULK_BOTTLINGS);
    expect(fixture.bulkVerdict.reported).toBe(BULK_BOTTLINGS);
  });

  it('pins a maker that a full knowledge-base pass then leaves alone', () => {
    expect(fixture.pinCommit.merged).toBe(false);
    expect(fixture.pinnedAfterReconcile.producerSource)
      .toBe(FactSource.MANUAL);
    expect(fixture.pinnedAfterReconcile.producerId).not.toBeNull();
  });

  /**
   * The picker offers all four kinds, because an alias to a bottler is how an
   * independent bottling resolves — but a pin writes the slot literally, and
   * the resolver refuses a bottler there for the whole catalogue.
   */
  it('refuses a bottler in the producer slot', () => {
    expect(fixture.bottlerRefusal).toMatch(/bottler cannot be the producer/);
  });
});
