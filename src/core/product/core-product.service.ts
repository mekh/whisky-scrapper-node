import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import {
  FlavorCandidateRow,
  ID,
  KbFactWrite,
  KbFlavorWrite,
  KbProducerWrite,
  KbReconcileRow,
  ProductCanonicalInput,
  ProductFactConflictInput,
  ProductFactReviewRow,
  ProductFillInput,
  ProductMatchRow,
  ProductNameCandidateRow,
  ProductScrapeFlavorLink,
  ProductSearchItem,
  ProductStoreFieldsRow,
  ProductStoredFactsRow,
  ReviewConflictRow,
  UntrustedFactCounts,
} from '~types';

import { ProductEntity } from './product.entity';
import { ProductRepository } from './product.repository';

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
   * Creates a bottling with no match key, which nothing can ever match.
   *
   * @param input - The bottling to create.
   * @returns The new canonical id.
   */
  public async createUnmatched(input: ProductCanonicalInput): Promise<ID> {
    return this.repo.createUnmatched(input);
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
   * Counts the bottlings whose type or country the filters no longer trust.
   *
   * @returns The per-field counts and the count of bottlings with either.
   */
  public async countUntrustedFacts(): Promise<UntrustedFactCounts> {
    return this.repo.countUntrustedFacts();
  }

  /**
   * Lists the bottlings whose type or country the filters distrust.
   *
   * @param field - `type`, `country`, or omit for either.
   * @param limit - Page size.
   * @param offset - Page offset.
   * @returns The rows and the total matching count.
   */
  public async findUntrustedFacts(
    field?: string,
    limit?: number,
    offset?: number,
    producer?: string,
  ): Promise<{ rows: ProductFactReviewRow[]; total: number }> {
    return this.repo.findUntrustedFacts(field, limit, offset, producer);
  }

  /**
   * Counts the unresolved cross-shop contradictions.
   *
   * @returns How many are open.
   */
  public async countOpenConflicts(): Promise<number> {
    return this.repo.countOpenConflicts();
  }

  /**
   * Lists the unresolved contradictions, worst-first.
   *
   * @param attribute - Restrict to one disputed attribute.
   * @param store - Restrict to one shop's claims, by slug.
   * @param limit - Page size.
   * @param offset - Page offset.
   * @returns The rows and the total matching count.
   */
  public async findConflicts(
    attribute?: string,
    store?: string,
    limit?: number,
    offset?: number,
  ): Promise<{ rows: ReviewConflictRow[]; total: number }> {
    return this.repo.findConflicts(attribute, store, limit, offset);
  }

  /**
   * Marks one contradiction settled.
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
    return this.repo.resolveConflict(productId, storeId, attribute);
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
