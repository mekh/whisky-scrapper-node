import { Injectable } from '@nestjs/common';

import {
  CACHE_GENERATION_CATALOGUE,
  REVIEW_PAGE_SIZE,
  REVIEW_SUGGESTION_LIMIT,
} from '~constants';
import { CoreProducerService } from '~core/producer';
import { CoreProductService } from '~core/product';
import { KbStatus, ReviewIssueCode } from '~enums';
import { NotFoundError } from '~errors';
import { VersionedCacheService } from '~lib/cache';
import type {
  ID,
  KbAliasEntry,
  KbProducerFacts,
  KbReconcileSummary,
  ProductReviewStatusResult,
  ProductSiblingFactRow,
  ProductSuggestionSourceRow,
  ReviewCandidateVia,
  ReviewInertHitIds,
  ReviewInertHits,
  ReviewProducerCandidate,
  ReviewQueueQuery,
  ReviewQueueRow,
  ReviewSiblings,
  ReviewSuggestions,
  ReviewSummary,
  TypePaginated,
} from '~types';
import { BrandHintUtils, KbAliasUtils, KbKeyUtils } from '~utils';

import { KbReconcileService } from '~scrape/kb';

import { ProducerReachService } from './producer-reach.service';
import { ProducerReviewService } from './producer-review.service';

import type { ProductReviewStatusInput } from './product-review.interfaces';

/**
 * How good each kind of producer evidence is, best first. A maker a shop
 * stated outright beats one merely named in a title.
 */
const CANDIDATE_RANK: Readonly<Record<ReviewCandidateVia, number>> = {
  brandOrig: 0,
  'tm-token': 1,
  'unreachable-alias': 2,
  'name-word': 3,
  similar: 4,
};

/**
 * Shortest word a listing URL's slug may contribute as a hint. Below this it
 * is a volume, a size or a stray letter.
 */
const URL_HINT_MIN_LENGTH = 3;

/**
 * The bottlings half of the curation screen: one queue of whiskies that need a
 * person, every reason each is in it, and the verdict that takes it out.
 *
 * The screen exists because nothing else puts a new row in front of anybody. A
 * sync mints a bottling from whatever a shop printed and the name cleaner, the
 * age reader and the flavour passes all guess; a truncated name, an age read
 * out of prose, a gift set recorded as one bottle or a bag of drink ice filed
 * under whisky sat in the reports until somebody tripped over it.
 *
 * Membership is the union of the detectors: a bottling is queued when it is
 * neither `verified` nor `rejected` **and** something fires. The detectors
 * themselves live in one SQL fragment, so the chip on a row and the chip in
 * the filter are the same object.
 */
@Injectable()
export class ProductReviewService {
  private readonly products: CoreProductService;

  private readonly coreProducers: CoreProducerService;

  private readonly producers: ProducerReviewService;

  private readonly reach: ProducerReachService;

  private readonly reconcile: KbReconcileService;

  private readonly cache: VersionedCacheService;

  public constructor(
    products: CoreProductService,
    coreProducers: CoreProducerService,
    producers: ProducerReviewService,
    reach: ProducerReachService,
    reconcile: KbReconcileService,
    cache: VersionedCacheService,
  ) {
    this.products = products;
    this.coreProducers = coreProducers;
    this.producers = producers;
    this.reach = reach;
    this.reconcile = reconcile;
    this.cache = cache;
  }

  /**
   * Applies the knowledge base to the catalogue.
   *
   * This is the other half of every decision the screen records. Promoting a
   * producer stores a claim and changes nothing a filter reads until the
   * catalogue is re-resolved, which is why a reviewer can promote two
   * producers and watch the queue not move.
   *
   * @returns What the pass wrote.
   */
  public async applyKnowledgeBase(): Promise<KbReconcileSummary> {
    const run = await this.reconcile.run();

    return run.summary;
  }

  /**
   * Lists one page of the curation queue.
   *
   * @param query - Issue, shop, search, slice, sort and paging.
   * @returns A page of bottlings, worst first by default.
   */
  public async queue(
    query: ReviewQueueQuery,
  ): Promise<TypePaginated<ReviewQueueRow>> {
    const limit = query.perPage ?? REVIEW_PAGE_SIZE;
    const offset = ((query.page ?? 1) - 1) * limit;

    const hits = await this.reach.inertHits();

    const { rows, total } = await this.products.findReviewQueue(
      { ...query, page: query.page ?? 1, perPage: limit },
      ProductReviewService.hitIds(hits),
    );

    const data = rows.map((row) =>
      ProductReviewService.nameInertProducer(row, hits)
    );

    return { data, total, limit, offset };
  }

  /**
   * Counts what is waiting, for the tabs and the «Проблеми» dropdown.
   *
   * @param includeAcknowledged - Whether acknowledged contradictions count,
   *   so the dropdown's own checkbox changes the numbers beside it.
   * @returns The counters.
   */
  public async summary(includeAcknowledged = false): Promise<ReviewSummary> {
    const hits = await this.reach.inertHits();

    const [counts, statuses, producers, appliedAt] = await Promise.all([
      this.products.countReviewIssues(
        ProductReviewService.hitIds(hits),
        includeAcknowledged,
      ),
      this.products.countReviewStatuses(),
      this.producers.summary(),
      this.reconcile.lastAppliedAt(),
    ]);

    return {
      open: counts.open,
      conflictOnly: counts.conflictOnly,
      byIssue: counts.byIssue,
      verifiedToday: statuses.verifiedToday,
      rejected: statuses.rejected,
      knowledgeBaseAppliedAt: appliedAt,
      producers,
    };
  }

  /**
   * Everything the side panel loads when a bottling is opened.
   *
   * Four questions, all answered from what the catalogue already holds: which
   * producer this might be, which bottling it might duplicate, what its
   * namesakes say about the facts it lacks, and what the shops' own URLs
   * spell that their titles do not.
   *
   * The producer candidates deliberately search the alias index **ignoring
   * scope and the length floor**. That is the whole `Hyde` case: the producer
   * exists, the spelling is four letters and brand-scoped, and no resolver
   * pass can ever reach it — so the only thing that can offer it to a person
   * is a search that knows the rule is being broken and says so, through
   * `via: 'unreachable-alias'`.
   *
   * @param id - The bottling.
   * @returns The candidates, the duplicates, the sibling values and the URL
   *   hints.
   * @throws {NotFoundError} When nothing has that id.
   */
  public async suggestions(id: ID): Promise<ReviewSuggestions> {
    const source = await this.products.findSuggestionSource(id);

    if (!source) {
      throw new NotFoundError('Product not found', { id });
    }

    const [live, withheld, duplicates, siblings] = await Promise.all([
      this.coreProducers.loadAliasIndex(),
      this.coreProducers.loadWithheldAliasIndex(),
      this.products.findDuplicateCandidates(id, REVIEW_SUGGESTION_LIMIT),
      this.products.findSiblingFacts(id),
    ]);

    return {
      producers: await this.producerCandidates(source, [...live, ...withheld]),
      duplicates,
      siblings: ProductReviewService.groupSiblings(siblings),
      storeHints: ProductReviewService.urlHints(source.urls),
    };
  }

  /**
   * Ranks the producers a bottling might belong to.
   *
   * Four ways in, best evidence first: the maker a shop stated outright, the
   * trademark token hidden in a raw name, an alias the resolver is forbidden
   * to look for inside a name, and a plain word of the name matching a
   * producer's own name.
   *
   * @param source - The bottling and its evidence.
   * @param aliases - The live index plus the withheld one, since a withheld
   *   producer is a legitimate answer a person can promote.
   * @returns The candidates, best first, without repeats.
   */
  private async producerCandidates(
    source: ProductSuggestionSourceRow,
    aliases: KbAliasEntry[],
  ): Promise<ReviewProducerCandidate[]> {
    const found = new Map<ID, ReviewProducerCandidate>();

    const offer = (
      producer: KbProducerFacts,
      via: ReviewCandidateVia,
      spelling: string,
    ): void => {
      if (!found.has(producer.id)) {
        found.set(producer.id, {
          producer: {
            id: producer.id,
            slug: producer.slug,
            name: producer.name,
            kind: producer.kind,
            status: KbStatus.AUTO,
          },
          countryIcon: null,
          via,
          spelling,
          productCount: 0,
        });
      }
    };

    const stated = source.brandOrig
      ? KbKeyUtils.key(source.brandOrig)
      : null;

    const hit = KbAliasUtils.matchByBrand(stated, aliases);

    if (hit && source.brandOrig) {
      offer(hit.producer, 'brandOrig', source.brandOrig);
    }

    source.rawNames.forEach((raw) => {
      const token = BrandHintUtils.fromRawName(raw);
      const byToken = token
        ? KbAliasUtils.matchByBrand(KbKeyUtils.key(token), aliases)
        : null;

      if (byToken && token) {
        offer(byToken.producer, 'tm-token', token);
      }
    });

    const nameKey = KbKeyUtils.normalize(source.name ?? '');
    const rawKey = KbKeyUtils.normalize(source.rawNames.join(' '));

    aliases.forEach((alias) => {
      if (found.size >= REVIEW_SUGGESTION_LIMIT || !alias.key) {
        return;
      }

      if (KbKeyUtils.matchesWord(nameKey, alias.key)) {
        offer(
          alias.producer,
          KbAliasUtils.reachesName(alias) ? 'name-word' : 'unreachable-alias',
          alias.key,
        );

        return;
      }

      if (KbKeyUtils.matchesWord(rawKey, alias.key)) {
        offer(alias.producer, 'similar', alias.key);
      }
    });

    return this.withProducerFacts([...found.values()]);
  }

  /**
   * Fills in each candidate's real status, flag and bottling count.
   *
   * The alias index carries a producer's facts but not its review status or
   * its country's flag, and both decide how the candidate reads: a withheld
   * row is an answer that also needs promoting, and the flag is what makes a
   * one-line candidate recognisable.
   *
   * @param candidates - The candidates as the matching found them.
   * @returns The same candidates, ranked and completed.
   */
  private async withProducerFacts(
    candidates: ReviewProducerCandidate[],
  ): Promise<ReviewProducerCandidate[]> {
    if (!candidates.length) {
      return [];
    }

    const rows = await this.coreProducers.findCandidateFacts(
      candidates.map((one) => one.producer.id),
    );

    const byId = new Map(rows.map((row) => [row.id, row]));

    return candidates
      .map((candidate) => {
        const row = byId.get(candidate.producer.id);

        return {
          ...candidate,
          producer: {
            ...candidate.producer,
            status: row?.status ?? candidate.producer.status,
          },
          countryIcon: row?.countryIcon ?? null,
          productCount: row?.productCount ?? 0,
        };
      })
      .sort((left, right) =>
        CANDIDATE_RANK[left.via] - CANDIDATE_RANK[right.via]
        || right.productCount - left.productCount
      );
  }

  /**
   * Groups the sibling values by the fact they describe.
   *
   * @param rows - The values as SQL returned them.
   * @returns One list per fact, most common first.
   */
  private static groupSiblings(
    rows: ProductSiblingFactRow[],
  ): ReviewSiblings {
    const siblings: ReviewSiblings = { abv: [], type: [], country: [] };

    rows.forEach((row) => {
      const bucket = siblings[row.fact as keyof ReviewSiblings];

      bucket?.push({ value: row.value, label: row.label, count: row.n });
    });

    return siblings;
  }

  /**
   * Lifts the readable words out of the shops' own listing URLs.
   *
   * A shop routinely spells a name correctly in its slug and truncates it in
   * the title — `grant-s-triple-wood` beside a listing that says `Grants` —
   * so the slug is evidence the canonical name was built without.
   *
   * @param urls - The listing URLs.
   * @returns The distinct slug words, longest first.
   */
  private static urlHints(urls: string[]): string[] {
    const words = new Set<string>();

    urls.forEach((url) => {
      const tail = url.split('?')[0].split('/').filter(Boolean).pop() ?? '';

      tail.split(/[-_]+/)
        .filter((word) => word.length >= URL_HINT_MIN_LENGTH)
        .forEach((word) => words.add(word.toLowerCase()));
    });

    return [...words].slice(0, REVIEW_SUGGESTION_LIMIT);
  }

  /**
   * Records a reviewer's verdict on a batch of bottlings.
   *
   * One method for all three transitions, because they differ only in the
   * value written — "back into the queue" and "un-reject" are the same
   * operation as "verify" with a different one.
   *
   * **The catalogue cache is bumped whatever the verdict**, not only when it
   * crosses the `rejected` boundary that actually changes what a report
   * returns: one request may carry both values, and a rule about which values
   * matter is a rule that drifts. The bulk shape is what makes that cheap.
   *
   * @param input - The bottlings and the verdict.
   * @returns How many rows were written, and the queue counters after it.
   */
  public async setStatus(
    input: ProductReviewStatusInput,
  ): Promise<ProductReviewStatusResult> {
    const updated = await this.products.applyReviewStatus(
      input.productIds,
      input.reviewStatus,
    );

    this.cache.bumpAfterCommit(CACHE_GENERATION_CATALOGUE, 'product:review');

    const products = await this.products.countReviewStatuses();

    return { updated, products };
  }

  /**
   * Flattens the what-if answer to the two id lists the detector query reads.
   *
   * @param hits - The what-if answer.
   * @returns The id lists.
   */
  private static hitIds(hits: ReviewInertHits): ReviewInertHitIds {
    return {
      rejected: [...hits.rejected.keys()],
      withheld: [...hits.withheld.keys()],
    };
  }

  /**
   * Names the producer behind a resolution-derived chip.
   *
   * "Resolves to Yakusun, ruled not whisky" is the sentence the person reads,
   * and only the what-if pass knows which producer that is — the detector
   * query was handed ids alone.
   *
   * @param row - The queue row.
   * @param hits - The what-if answer.
   * @returns The row with those chips carrying a producer name.
   */
  private static nameInertProducer(
    row: ReviewQueueRow,
    hits: ReviewInertHits,
  ): ReviewQueueRow {
    const named: Partial<Record<ReviewIssueCode, KbProducerFacts>> = {
      [ReviewIssueCode.PRODUCER_REJECTED]: hits.rejected.get(row.id),
      [ReviewIssueCode.PRODUCER_WITHHELD]: hits.withheld.get(row.id),
    };

    const issues = row.issues.map((issue) => {
      const producer = named[issue.code];

      return producer
        ? { ...issue, detail: producer.name, producerId: producer.id }
        : issue;
    });

    return { ...row, issues };
  }
}
