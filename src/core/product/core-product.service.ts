import { Injectable } from '@nestjs/common';

import { REVIEW_ISSUE_SEVERITY, REVIEW_SCOTLAND_CODE } from '~constants';
import { CoreBaseService } from '~core/_common';
import { ProductFactField, ProductReviewStatus, ReviewIssueCode } from '~enums';
import {
  FlavorCandidateRow,
  ID,
  KbFactWrite,
  KbFlavorWrite,
  KbProducerWrite,
  KbReconcileRow,
  ProducerProductRow,
  ProductCanonicalInput,
  ProductFactConflictInput,
  ProductFillInput,
  ProductMatchRow,
  ProductNameCandidateRow,
  ProductReviewStatusCounts,
  ProductScrapeFlavorLink,
  ProductSearchItem,
  ProductSiblingFactRow,
  ProductStoreFieldsRow,
  ProductStoredFactsRow,
  ProductSuggestionSourceRow,
  ProductUnresolvedNameRow,
  ReviewDuplicateCandidate,
  ReviewInertHitIds,
  ReviewIssue,
  ReviewIssueCounts,
  ReviewQueueQuery,
  ReviewQueueRow,
} from '~types';
import { BrandHintUtils } from '~utils';

import { ProductEntity } from './product.entity';
import { ProductRepository } from './product.repository';

import type { ReviewQueueSqlRow } from './product.interfaces';

/**
 * Which fact each detector is about, where it is about one. Read by the client
 * to put a fix button beside the right field; stated once, here, so the chip
 * and the button cannot name different fields.
 */
const ISSUE_FIELD: Readonly<Partial<Record<ReviewIssueCode, string>>> = {
  [ReviewIssueCode.MISSING_ABV]: 'abv',
  [ReviewIssueCode.MISSING_VOLUME]: 'volume',
  [ReviewIssueCode.MISSING_COUNTRY]: 'country',
  [ReviewIssueCode.MISSING_TYPE]: 'type',
  [ReviewIssueCode.TYPE_VS_NAME]: 'type',
  [ReviewIssueCode.COUNTRY_VS_NAME]: 'country',
  [ReviewIssueCode.ABV_RANGE]: 'abv',
  [ReviewIssueCode.NAME_LEFTOVER]: 'name',
  [ReviewIssueCode.CYRILLIC_NAME]: 'name',
  [ReviewIssueCode.AGE_IN_RAW]: 'age',
  [ReviewIssueCode.AGE_SINGLE_STORE]: 'age',
  [ReviewIssueCode.NO_PRODUCER]: 'producer',
  [ReviewIssueCode.PRODUCER_REJECTED]: 'producer',
  [ReviewIssueCode.PRODUCER_WITHHELD]: 'producer',
};

/**
 * Persistence-layer public API for the canonical `product` entity — the
 * bottling, not the offer. Identity is the derived `matchKey`, unique at the
 * database level and frozen once a row exists; the stores' offers live in
 * `store_product` and reach a bottling through it.
 */
@Injectable()
export class CoreProductService extends CoreBaseService<ProductEntity> {
  public constructor(protected readonly repo: ProductRepository) {
    super(repo);
  }

  /**
   * Turns one detector row into the shape the screen reads.
   *
   * @param row - The row as SQL returned it.
   * @returns The row with its issues explained and its offers annotated.
   */
  private static toQueueRow(row: ReviewQueueSqlRow): ReviewQueueRow {
    const issues = row.issues.map((code) =>
      CoreProductService.toIssue(code as ReviewIssueCode, row)
    );

    const offers = row.offers.map((offer) => ({
      ...offer,
      brandHint: BrandHintUtils.fromRawName(offer.nameOrig),
    }));

    return { ...row, issues, offers };
  }

  /**
   * Explains one code: how bad it is, which field it is about, and what the
   * detector actually found.
   *
   * @param code - The code that fired.
   * @param row - The row it fired on, for the codes that quote a value.
   * @returns The explained issue.
   */
  private static toIssue(
    code: ReviewIssueCode,
    row: ReviewQueueSqlRow,
  ): ReviewIssue {
    const issue: ReviewIssue = {
      code,
      severity: REVIEW_ISSUE_SEVERITY[code],
    };

    const field = ISSUE_FIELD[code];

    if (field) {
      issue.field = field;
    }

    if (code === ReviewIssueCode.TYPE_VS_NAME && row.namedType) {
      issue.detail = row.namedType;
    }

    /*
      The detector fires on Scotland's regions and on nothing else, so the
      country it means is a constant — but it is this file's constant, not the
      client's. Stating it here is what lets the screen offer the fix without
      a second copy of the vocabulary.
    */
    if (code === ReviewIssueCode.COUNTRY_VS_NAME) {
      issue.detail = REVIEW_SCOTLAND_CODE;
    }

    return issue;
  }

  /**
   * Looks up what the catalogue already knows about a set of bottlings, so an
   * enrichment pass can skip whatever is answered already.
   *
   * @param keys - Match keys to look up.
   * @returns Map from match key to the stored row; unmatched keys are absent.
   */
  public async findByMatchKeys(
    keys: string[],
  ): Promise<Map<string, ProductMatchRow>> {
    return this.repo.findByMatchKeys(keys);
  }

  /**
   * Which of the given canonical ids exist, so a caller can reject the rest as
   * a bad request instead of hitting a foreign-key violation.
   *
   * @param ids - Canonical product ids to check; duplicates are ignored.
   * @returns The subset that exists.
   */
  public async findExistingIds(ids: ID[]): Promise<Set<ID>> {
    return this.repo.findExistingIds(ids);
  }

  /**
   * Autocomplete search over the whole catalogue, one row per bottling.
   * Deliberately not preference-filtered — see the repository's `SEARCH_SQL`.
   *
   * @param term - The substring to look for.
   * @param limit - Rows to return at most.
   * @returns Matching bottlings, best matches first.
   */
  public async search(
    term: string,
    limit: number,
  ): Promise<ProductSearchItem[]> {
    return this.repo.searchByName(term, limit);
  }

  /**
   * Resolves a batch of bottlings to canonical ids, creating the unknown ones.
   *
   * @param inputs - One entry per distinct match key, deduplicated and sorted
   *   by key.
   * @returns Map from match key to canonical id, and how many were created.
   */
  public async findOrCreateByMatchKeys(
    inputs: ProductCanonicalInput[],
  ): Promise<{ ids: Map<string, ID>; added: number }> {
    return this.repo.findOrCreateByMatchKeys(inputs);
  }

  /**
   * Creates a bottling with no match key. Nothing matches it by key; a later
   * listing can still reach it by identity, since the find-or-create step
   * compares name, volume and age before it creates anything.
   *
   * @param input - The bottling to create.
   * @returns The new canonical id.
   */
  public async createUnmatched(input: ProductCanonicalInput): Promise<ID> {
    return this.repo.createUnmatched(input);
  }

  /**
   * Every other bottling with the same identity — name, volume and age.
   *
   * @param name - The display name, or null, which matches nothing.
   * @param volumeMl - The volume, or null.
   * @param age - The age statement, or null for NAS.
   * @param exceptId - A bottling to leave out.
   * @returns The twins' ids, most-listed first.
   */
  public async findIdentityTwins(
    name: string | null,
    volumeMl: number | null,
    age: number | null,
    exceptId: ID | null = null,
  ): Promise<ID[]> {
    return this.repo.findIdentityTwins(name, volumeMl, age, exceptId);
  }

  /**
   * Folds one bottling into another that is the same whisky and deletes it;
   * offers, prices, flavors, conflicts, every user's lists and the retired
   * key all move to the survivor. Runs in the caller's transaction.
   *
   * @param loserId - The bottling to fold away.
   * @param survivorId - The bottling to keep.
   * @returns Resolves once the vanishing row is gone.
   */
  public async mergeInto(loserId: ID, survivorId: ID): Promise<void> {
    return this.repo.mergeInto(loserId, survivorId);
  }

  /**
   * Deletes a bottling nothing refers to any more; a row somebody still lists
   * or holds is kept.
   *
   * @param id - The bottling to delete if it is unreferenced.
   * @returns True when the row was deleted.
   */
  public async deleteIfUnreferenced(id: ID): Promise<boolean> {
    return this.repo.deleteIfUnreferenced(id);
  }

  /**
   * Fills still-null strength, brand, type and country on stored bottlings; a
   * stored value is never overwritten.
   *
   * @param inputs - One patch per canonical product.
   * @returns How many bottlings gained a value.
   */
  public async fillMissing(inputs: ProductFillInput[]): Promise<number> {
    return this.repo.fillMissing(inputs);
  }

  /**
   * Adds keyword-derived flavor links without removing any, so one store's
   * silence cannot erase another's finding.
   *
   * @param links - Product/flavor pairs to add.
   * @returns Resolves once the links are stored.
   */
  public async addScrapeFlavors(
    links: ProductScrapeFlavorLink[],
  ): Promise<void> {
    return this.repo.addScrapeFlavors(links);
  }

  /**
   * Replaces a bottling's LLM-derived flavor links and stamps the answer time,
   * including when the answer was "unknown".
   *
   * @param productId - Canonical product id.
   * @param flavorIds - Flavor ids the model returned.
   * @returns Resolves once the links are replaced and the stamp is written.
   */
  public async setLlmFlavors(productId: ID, flavorIds: ID[]): Promise<void> {
    return this.repo.setLlmFlavors(productId, flavorIds);
  }

  /**
   * Replaces a bottling's whole flavor set with a person's choice and marks it
   * curated, which locks the keyword and LLM passes out of it for good.
   *
   * @param productId - Canonical product id.
   * @param flavorIds - Flavor ids to keep; an empty list means "no tags".
   * @returns Resolves once the set is stored and the bottling is marked.
   */
  public async setManualFlavors(productId: ID, flavorIds: ID[]): Promise<void> {
    return this.repo.setManualFlavors(productId, flavorIds);
  }

  /**
   * Loads every bottling with a representative raw name, flagging the ones a
   * store filter covers.
   *
   * @param storeSlug - Restrict the rewrite to bottlings a store carries.
   * @returns Every bottling, with its representative raw name.
   */
  public async findNameCandidates(
    storeSlug?: string,
  ): Promise<ProductNameCandidateRow[]> {
    return this.repo.findNameCandidates(storeSlug);
  }

  /**
   * Loads the bottlings a store carries, one row per SKU, with the fields a
   * backfill can fill.
   *
   * @param storeId - Store id.
   * @returns One row per offer the store lists.
   */
  public async findCarriedByStore(
    storeId: ID,
  ): Promise<ProductStoreFieldsRow[]> {
    return this.repo.findCarriedByStore(storeId);
  }

  /**
   * Records which producer and bottler the knowledge base placed each bottling
   * with.
   *
   * @param writes - One assignment per bottling.
   * @returns How many bottlings changed.
   */
  public async setProducers(writes: KbProducerWrite[]): Promise<number> {
    return this.repo.setProducers(writes);
  }

  /**
   * Writes the country and whisky type the knowledge base states.
   *
   * @param writes - One entry per bottling; a null field states nothing and
   *   leaves the stored value alone.
   * @returns How many bottlings changed.
   */
  public async applyKbFacts(writes: KbFactWrite[]): Promise<number> {
    return this.repo.applyKbFacts(writes);
  }

  /**
   * Applies the knowledge base's flavor decisions, links and unlinks alike.
   *
   * @param writes - One entry per bottling.
   * @returns Resolves once the links are written.
   */
  public async applyKbFlavors(writes: KbFlavorWrite[]): Promise<void> {
    return this.repo.applyKbFlavors(writes);
  }

  /**
   * Records the store claims that contradict the catalogue.
   *
   * @param conflicts - The claims observed during a scrape.
   * @returns Resolves once the log is written.
   */
  public async logFactConflicts(
    conflicts: ProductFactConflictInput[],
  ): Promise<void> {
    return this.repo.logFactConflicts(conflicts);
  }

  /**
   * Reads the stored facts of a set of bottlings, with their provenance.
   *
   * @param ids - The bottlings being written this run.
   * @returns One row per bottling that exists.
   */
  public async findFactsByIds(ids: ID[]): Promise<ProductStoredFactsRow[]> {
    return this.repo.findFactsByIds(ids);
  }

  /**
   * Pins a bottling's maker by hand, stamping the link `manual` so no pass
   * moves it.
   *
   * @param productId - The bottling.
   * @param producerId - The maker, or null to clear it.
   * @param bottlerId - The bottler, or null to clear it.
   * @returns How many rows were written.
   */
  public async setProducerManual(
    productId: ID,
    producerId: ID | null,
    bottlerId: ID | null,
  ): Promise<number> {
    return this.repo.setProducerManual(productId, producerId, bottlerId);
  }

  /**
   * Stamps facts `manual` without changing their values.
   *
   * @param productId - The bottling.
   * @param fields - The fact fields to stamp.
   * @returns How many rows were written.
   */
  public async stampManual(
    productId: ID,
    fields: ProductFactField[],
  ): Promise<number> {
    return this.repo.stampManual(productId, fields);
  }

  /**
   * Acknowledges every open contradiction recorded against a bottling.
   *
   * @param productId - The bottling.
   * @returns How many were acknowledged.
   */
  public async acknowledgeConflicts(productId: ID): Promise<number> {
    return this.repo.acknowledgeConflicts(productId);
  }

  /**
   * The display names behind a set of producer, type and country ids.
   *
   * @param ids - The ids to name.
   * @returns Id to display name; an id nothing has is absent.
   */
  public async findLabelsByIds(ids: ID[]): Promise<Map<ID, string>> {
    return this.repo.findLabelsByIds(ids);
  }

  /**
   * Everything the per-bottling suggestions are derived from.
   *
   * @param id - The bottling.
   * @returns Its facts and its evidence, or null when nothing has that id.
   */
  public async findSuggestionSource(
    id: ID,
  ): Promise<ProductSuggestionSourceRow | null> {
    return this.repo.findSuggestionSource(id);
  }

  /**
   * The bottlings one row may be a second copy of.
   *
   * @param id - The bottling to compare against.
   * @param limit - How many candidates to return.
   * @returns The candidates, exact twins first.
   */
  public async findDuplicateCandidates(
    id: ID,
    limit: number,
  ): Promise<ReviewDuplicateCandidate[]> {
    return this.repo.findDuplicateCandidates(id, limit);
  }

  /**
   * What identically-named bottlings state about the facts this one lacks.
   *
   * @param id - The bottling.
   * @returns One list per fact, most common value first.
   */
  public async findSiblingFacts(id: ID): Promise<ProductSiblingFactRow[]> {
    return this.repo.findSiblingFacts(id);
  }

  /**
   * The stocked bottlings that resolve to no maker, with the names one could
   * be found in.
   *
   * @returns One row per unresolved stocked bottling.
   */
  public async findUnresolvedNames(): Promise<ProductUnresolvedNameRow[]> {
    return this.repo.findUnresolvedNames();
  }

  /**
   * Counts the catalogue by its place in the new-product queue.
   *
   * @returns The `pending` / `verified` / `rejected` / `legacy` counts.
   */
  public async countReviewStatuses(): Promise<ProductReviewStatusCounts> {
    return this.repo.countReviewStatuses();
  }

  /**
   * Lists one page of the curation queue, each row carrying why it is there.
   *
   * The detectors run in SQL; two things are added here rather than there. The
   * severity of each code comes from `REVIEW_ISSUE_SEVERITY`, the same map the
   * client colours its chips by, so there is one answer to "how bad is this".
   * And each offer's brand token comes from `BrandHintUtils`, the one place
   * the `(Країна, ТМ Brand)` shape is read — putting either in SQL would be a
   * second copy of a rule that already exists.
   *
   * @param query - Issue, shop, search, slice, sort and paging.
   * @param hits - What the what-if pass concluded about the bottlings that
   *   resolve to nothing.
   * @returns The page and the total matching count.
   */
  public async findReviewQueue(
    query: ReviewQueueQuery,
    hits: ReviewInertHitIds,
  ): Promise<{ rows: ReviewQueueRow[]; total: number }> {
    const { rows, total } = await this.repo.findReviewQueue(query, hits);

    return {
      rows: rows.map((row) => CoreProductService.toQueueRow(row)),
      total,
    };
  }

  /**
   * Counts the open queue and how many bottlings each detector fires on.
   *
   * @param hits - The what-if answer.
   * @param includeAcknowledged - Whether acknowledged contradictions count.
   * @returns The open total, the contradiction-only share and the tally.
   */
  public async countReviewIssues(
    hits: ReviewInertHitIds,
    includeAcknowledged = false,
  ): Promise<ReviewIssueCounts> {
    return this.repo.countReviewIssues(hits, includeAcknowledged);
  }

  /**
   * Records a reviewer's verdict on a batch of bottlings — the one writer of
   * `product.reviewStatus` outside the insert default.
   *
   * @param ids - The bottlings to stamp.
   * @param status - The verdict.
   * @param onlyWhenPending - Stamp only rows still waiting in the queue,
   *   leaving a legacy, verified or rejected row untouched.
   * @returns How many rows were stamped.
   */
  public async applyReviewStatus(
    ids: ID[],
    status: ProductReviewStatus,
    onlyWhenPending = false,
  ): Promise<number> {
    return this.repo.applyReviewStatus(ids, status, onlyWhenPending);
  }

  /**
   * Lists the bottlings resolved to a producer, in either slot.
   *
   * @param producerId - The producer or bottler.
   * @returns The bottlings, alphabetically by display name.
   */
  public async findResolvedByProducer(
    producerId: ID,
  ): Promise<ProducerProductRow[]> {
    return this.repo.findResolvedByProducer(producerId);
  }

  /**
   * Reads specific bottlings as producer-expansion rows.
   *
   * @param ids - The bottlings to read.
   * @returns The bottlings, alphabetically by display name.
   */
  public async findProducerProductsByIds(
    ids: ID[],
  ): Promise<ProducerProductRow[]> {
    return this.repo.findProducerProductsByIds(ids);
  }

  /**
   * Loads every bottling the reconciliation pass may touch.
   *
   * @param storeSlug - Narrow to bottlings some store lists.
   * @param brand - Narrow to one brand name.
   * @param ids - Narrow to specific bottlings, as the sync path does.
   * @returns One row per bottling, flavor links included.
   */
  public async findKbReconcileCandidates(
    storeSlug?: string,
    brand?: string,
    ids?: ID[],
  ): Promise<KbReconcileRow[]> {
    return this.repo.findKbReconcileCandidates(storeSlug, brand, ids);
  }

  /**
   * Loads the bottlings the LLM flavor pass has never answered for.
   *
   * @param storeSlug - Restrict to bottlings a given store carries.
   * @returns One candidate per bottling still lacking an answer.
   */
  public async findFlavorCandidates(
    storeSlug?: string,
  ): Promise<FlavorCandidateRow[]> {
    return this.repo.findFlavorCandidates(storeSlug);
  }
}
