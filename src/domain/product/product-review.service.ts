import { Injectable } from '@nestjs/common';

import { CoreProducerService } from '~core/producer';
import { CoreProductService } from '~core/product';
import { KbStatus } from '~enums';
import { NotFoundError } from '~errors';
import type {
  ID,
  KbReconcileSummary,
  ProducerDetail,
  ProducerPatchResult,
  ProducerReviewRow,
  ProductFactReviewRow,
  ProductReviewSummary,
  ReviewConflictRow,
  TypePaginated,
} from '~types';

import { KbReconcileService } from '~scrape/kb';

import { ProducerReachService } from './producer-reach.service';

import type {
  ProducerPatchInput,
  ReviewConflictQuery,
  ReviewFactQuery,
  ReviewProducerQuery,
} from './product-review.interfaces';

/**
 * Default page size for every review listing.
 */
const PAGE_SIZE = 50;

/**
 * The read and write side of the curation screen.
 *
 * It exists because the knowledge base ships mostly **withheld**: the auto-gate
 * requires a positive peat claim to carry independent corroboration, so roughly
 * three producers in five are stored and ignored until a person looks at them.
 * Without somewhere to look, that research is simply lost, and the catalogue
 * keeps the honest-but-thin answer forever.
 *
 * The same screen carries the two other things nobody could otherwise see: the
 * facts still sourced `llm` or `legacy`, which the filters now distrust, and
 * the cross-shop contradictions the scrape logs but nothing surfaces.
 */
@Injectable()
export class ProductReviewService {
  private readonly producers: CoreProducerService;

  private readonly products: CoreProductService;

  private readonly reach: ProducerReachService;

  private readonly reconcile: KbReconcileService;

  public constructor(
    producers: CoreProducerService,
    products: CoreProductService,
    reach: ProducerReachService,
    reconcile: KbReconcileService,
  ) {
    this.producers = producers;
    this.products = products;
    this.reach = reach;
    this.reconcile = reconcile;
  }

  /**
   * Applies the knowledge base to the catalogue.
   *
   * This is the other half of every decision the screen records. Promoting a
   * producer stores a claim and changes nothing a filter reads: no bottling
   * points at that producer until the catalogue is re-resolved, which is why a
   * reviewer can promote two producers and watch the review queue not move. A
   * store sync re-resolves only what that run touched, so on its own it
   * applies a promotion in unpredictable instalments.
   *
   * The pass is `KbReconcileService`, shared verbatim with
   * `pnpm reconcile-flavors` — never a second copy of it. It is idempotent, so
   * pressing the button twice reports zeros the second time.
   *
   * @returns What the pass wrote.
   */
  public async applyKnowledgeBase(): Promise<KbReconcileSummary> {
    const run = await this.reconcile.run();

    return run.summary;
  }

  /**
   * Counts what is waiting, per category.
   *
   * @returns The counters the screen's tabs badge themselves with.
   */
  public async summary(): Promise<ProductReviewSummary> {
    const [statuses, facts, conflicts, unresolved] = await Promise.all([
      this.producers.countByStatus(),
      this.products.countUntrustedFacts(),
      this.products.countOpenConflicts(),
      this.producers.listUnresolvedBrands(1),
    ]);

    return {
      producers: {
        verified: statuses.verified ?? 0,
        auto: statuses.auto ?? 0,
        unverified: statuses.unverified ?? 0,
        rejected: statuses.rejected ?? 0,
      },
      untrustedTypes: facts.type,
      untrustedCountries: facts.country,
      untrustedFacts: facts.either,
      untrustedFactsUnresolved: facts.eitherUnresolved,
      openConflicts: conflicts,
      unresolvedBrands: unresolved.length,
    };
  }

  /**
   * Lists producers awaiting review, worst-first by catalogue reach.
   *
   * The withheld tab is ranked by **potential** reach and paged in memory;
   * every other status keeps the plain SQL paging. The split is not an
   * optimisation, it is the difference between a usable queue and an
   * alphabetical one: a withheld producer resolves to nothing by construction,
   * so the SQL ordering by `productCount` is ordering by zero. See
   * {@link ProducerReachService} for what the number means and why it is
   * computed rather than stored.
   *
   * Paging in memory is affordable because the whole table is 796 rows; if
   * that ever stops being true, the ranking is the thing to cache, not the
   * paging to move back into SQL.
   *
   * @param query - Status filter and paging.
   * @returns A page of producers.
   */
  public async producersPage(
    query: ReviewProducerQuery,
  ): Promise<TypePaginated<ProducerReviewRow>> {
    const limit = query.perPage ?? PAGE_SIZE;
    const offset = ((query.page ?? 1) - 1) * limit;

    if (query.status !== KbStatus.UNVERIFIED) {
      const { rows, total } = await this.producers.listForReview(
        query.status,
        limit,
        offset,
      );

      return { data: rows, total, limit, offset };
    }

    const [listed, reach] = await Promise.all([
      this.producers.listForReview(query.status, null, 0),
      this.reach.withheldReach(),
    ]);

    const ranked = listed.rows
      .map((row) => ({ ...row, potentialReach: reach.get(row.id) ?? 0 }))
      .sort((left, right) =>
        right.potentialReach - left.potentialReach
        || left.slug.localeCompare(right.slug)
      );

    return {
      data: ranked.slice(offset, offset + limit),
      total: listed.total,
      limit,
      offset,
    };
  }

  /**
   * Lists the bottlings whose type or country the filters no longer trust.
   *
   * @param query - Field filter and paging.
   * @returns A page of facts, worst-first by how many shops carry the
   *   bottling.
   */
  public async factsPage(
    query: ReviewFactQuery,
  ): Promise<TypePaginated<ProductFactReviewRow>> {
    const limit = query.perPage ?? PAGE_SIZE;
    const offset = ((query.page ?? 1) - 1) * limit;

    const { rows, total } = await this.products.findUntrustedFacts(
      query.field,
      limit,
      offset,
      query.producer,
    );

    return { data: rows, total, limit, offset };
  }

  /**
   * Lists the unresolved cross-shop contradictions, worst-first.
   *
   * @param query - Attribute and store filters, plus paging.
   * @returns A page of contradictions.
   */
  public async conflictsPage(
    query: ReviewConflictQuery,
  ): Promise<TypePaginated<ReviewConflictRow>> {
    const limit = query.perPage ?? PAGE_SIZE;
    const offset = ((query.page ?? 1) - 1) * limit;

    const { rows, total } = await this.products.findConflicts(
      query.attribute,
      query.store,
      limit,
      offset,
    );

    return { data: rows, total, limit, offset };
  }

  /**
   * Lists the brand keys nothing in the knowledge base resolves.
   *
   * @param limit - How many to return.
   * @returns Brand names with the number of bottlings behind them.
   */
  public async unresolvedBrands(
    limit?: number,
  ): Promise<{ brand: string; productCount: number }[]> {
    return this.producers.listUnresolvedBrands(limit);
  }

  /**
   * Applies a reviewer's edit to a producer **and to the catalogue**.
   *
   * Any field the reviewer changed is written, and the row is stamped with the
   * moment it happened. `verified` outranks the auto-gate, so a promoted row
   * goes live regardless of what the gate concluded about its citations.
   *
   * **The catalogue pass runs here, in the same request, and that is the
   * point.** Storing the decision alone changes nothing a filter reads: no
   * bottling points at the producer until the catalogue is re-resolved, so a
   * reviewer promoting two producers watched the review counts stay exactly
   * where they were and was right to call that broken. There is no reason to
   * defer it — the pass costs ~200 ms over the whole catalogue, is idempotent,
   * never touches a `manual` value, and a wrong promotion is undone by
   * demoting and letting the next pass rewrite it.
   *
   * It runs on **every** edit rather than only the ones that can change
   * resolution. A rule about which fields matter is a rule that drifts, and
   * the pass writes nothing when nothing changed.
   *
   * @param id - The producer to edit.
   * @param patch - The fields to change; an absent field is left alone.
   * @returns The producer as it now stands, and what applying it wrote.
   * @throws {NotFoundError} When no producer has that id.
   */
  public async patchProducer(
    id: ID,
    patch: ProducerPatchInput,
  ): Promise<ProducerPatchResult> {
    const updated = await this.producers.applyReview(id, patch);

    if (!updated) {
      throw new NotFoundError('Producer not found');
    }

    const run = await this.reconcile.run();

    return { producer: updated, applied: run.summary };
  }

  /**
   * Reads one producer with everything that overrides its facts.
   *
   * @param id - The producer to read.
   * @returns The producer, its child lines and the rules that bear on it.
   * @throws {NotFoundError} When no producer has that id.
   */
  public async producerDetail(id: ID): Promise<ProducerDetail> {
    const detail = await this.producers.findDetail(id);

    if (!detail) {
      throw new NotFoundError('Producer not found');
    }

    return detail;
  }

  /**
   * Marks a cross-shop contradiction settled.
   *
   * Resolving records a decision, not a correction — the fact itself is
   * changed through `POST /product/update`, which stamps `manual`. A
   * contradiction seen again after this is un-resolved by the scrape, because
   * a disagreement somebody dismissed that keeps arriving is not dismissed.
   *
   * @param productId - The bottling.
   * @param storeId - The shop making the claim.
   * @param attribute - Which fact is disputed.
   * @returns Resolves once the row is marked.
   */
  public async resolveConflict(
    productId: ID,
    storeId: ID,
    attribute: string,
  ): Promise<void> {
    await this.products.resolveConflict(productId, storeId, attribute);
  }
}
