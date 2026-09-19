import { Injectable } from '@nestjs/common';

import { REVIEW_PAGE_SIZE } from '~constants';
import { CoreProducerService } from '~core/producer';
import { CoreProductService } from '~core/product';
import { KbStatus } from '~enums';
import { DuplicateError, NotFoundError } from '~errors';
import type {
  ID,
  KbReconcileSummary,
  ProducerDetail,
  ProducerPatchResult,
  ProducerProductRow,
  ProducerQueueQuery,
  ProducerQueueRow,
  ProducerRuleCreateInput,
  ReviewProducerSummary,
  TypePaginated,
} from '~types';

import { KbReconcileService } from '~scrape/kb';

import { ProducerReachService } from './producer-reach.service';
import { ProducerRuleFactory } from './producer-rule.factory';

import type { ProducerPatchInput } from './product-review.interfaces';

/**
 * How many withheld producers the ranking pass reads at once.
 *
 * The withheld slice is ranked by **potential** reach and paged in memory,
 * because a withheld producer resolves to nothing by construction — ordering
 * it by `productCount` is ordering by zero, which is what left 466 rows
 * untouched. The whole table is under a thousand rows, so reading it whole is
 * cheaper than the ranking it feeds; if that stops being true, the ranking is
 * the thing to cache, not the paging to move back into SQL.
 */
const UNRANKED_PAGE = 1000;

/**
 * Postgres unique-violation error code, mapped to a 409.
 */
const UNIQUE_VIOLATION = '23505';

/**
 * The producer half of the curation screen: the queue of makers that need a
 * person, and every write that answers one.
 *
 * Split from {@link ProductReviewService} because the two queues answer
 * different questions and share no predicate — a bottling is wrong, a producer
 * is unreachable or unresearched — and because a single service holding both
 * had grown past what one file should carry.
 *
 * **Every write here applies itself.** A stored claim changes nothing a filter
 * reads until the catalogue is re-resolved, so the pass runs in the same
 * request and the response says what it wrote.
 */
@Injectable()
export class ProducerReviewService {
  private readonly producers: CoreProducerService;

  private readonly products: CoreProductService;

  private readonly rules: ProducerRuleFactory;

  private readonly reach: ProducerReachService;

  private readonly reconcile: KbReconcileService;

  public constructor(
    producers: CoreProducerService,
    products: CoreProductService,
    rules: ProducerRuleFactory,
    reach: ProducerReachService,
    reconcile: KbReconcileService,
  ) {
    this.producers = producers;
    this.products = products;
    this.rules = rules;
    this.reach = reach;
    this.reconcile = reconcile;
  }

  /**
   * Lists one page of the producers queue, each row carrying why it is there.
   *
   * @param query - Issue, status, kind, search and paging.
   * @returns A page of producers, worst first.
   */
  public async queue(
    query: ProducerQueueQuery,
  ): Promise<TypePaginated<ProducerQueueRow>> {
    const limit = query.perPage ?? REVIEW_PAGE_SIZE;
    const offset = ((query.page ?? 1) - 1) * limit;

    const hints = await this.reach.producerHints();

    if (query.status !== KbStatus.UNVERIFIED) {
      const { rows, total } = await this.producers.findQueue(query, hints);

      return { data: rows, total, limit, offset };
    }

    const [listed, reach] = await Promise.all([
      this.producers.findQueue(
        { ...query, page: 1, perPage: UNRANKED_PAGE },
        hints,
      ),
      this.reach.withheldReach(),
    ]);

    const ranked = listed.rows
      .map((row) => ({ ...row, potentialReach: reach.get(row.id) ?? 0 }))
      .sort((left, right) =>
        (right.potentialReach ?? 0) - (left.potentialReach ?? 0)
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
   * Counts the producers queue, by code.
   *
   * @returns The open total and the per-code tally.
   */
  public async summary(): Promise<ReviewProducerSummary> {
    const hints = await this.reach.producerHints();

    return this.producers.countQueueIssues(hints);
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
   * The catalogue pass runs here, in the same request, and that is the point:
   * storing the decision alone changes nothing a filter reads, so a reviewer
   * promoting two producers watched the review counts stay exactly where they
   * were and was right to call that broken.
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
   * Lists the bottlings behind one producer row.
   *
   * A live producer lists what resolves to it **today**, in either slot. A
   * withheld one resolves to nothing by construction, so its list is the same
   * what-if pass its reach ranking came from.
   *
   * @param id - The producer.
   * @returns The bottlings, alphabetically by display name.
   * @throws {NotFoundError} When no producer has that id.
   */
  public async producerProducts(id: ID): Promise<ProducerProductRow[]> {
    const producer = await this.producers.findReviewRow(id);

    if (!producer) {
      throw new NotFoundError('Producer not found');
    }

    const live = producer.status === KbStatus.VERIFIED
      || producer.status === KbStatus.AUTO;

    if (live) {
      return this.products.findResolvedByProducer(id);
    }

    const ids = await this.reach.withheldProductIds(id);

    return this.products.findProducerProductsByIds(ids);
  }

  /**
   * Creates one producer-scoped name-pattern rule **and applies it**.
   *
   * @param id - The producer the rule is scoped to.
   * @param input - The rule as the reviewer stated it.
   * @returns What applying the rule wrote.
   * @throws {NotFoundError} When no producer has that id.
   * @throws {BadRequestError} When the rule states both claims, neither, an
   *   unknown flavour, or a pattern that normalizes to nothing.
   * @throws {DuplicateError} When the producer already has a rule for that
   *   pattern and tag.
   */
  public async createProducerRule(
    id: ID,
    input: ProducerRuleCreateInput,
  ): Promise<KbReconcileSummary> {
    const producer = await this.producers.findReviewRow(id);

    if (!producer) {
      throw new NotFoundError('Producer not found');
    }

    const draft = await this.rules.build(input);

    try {
      await this.producers.createRule({ ...draft, producerId: id });
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new DuplicateError(
          'The producer already has a rule for this pattern',
        );
      }

      throw error;
    }

    const run = await this.reconcile.run();

    return run.summary;
  }

  /**
   * Deletes one of a producer's own rules **and applies the removal**.
   *
   * Scoped to the producer, so a global rule — migration-authored context —
   * is unreachable by construction rather than by a check someone could
   * forget.
   *
   * @param id - The producer the rule belongs to.
   * @param ruleId - The rule to delete.
   * @returns What applying the removal wrote.
   * @throws {NotFoundError} When the rule does not exist or is not that
   *   producer's.
   */
  public async deleteProducerRule(
    id: ID,
    ruleId: ID,
  ): Promise<KbReconcileSummary> {
    const deleted = await this.producers.deleteRule(ruleId, id);

    if (deleted === 0) {
      throw new NotFoundError('Rule not found');
    }

    const run = await this.reconcile.run();

    return run.summary;
  }
}
