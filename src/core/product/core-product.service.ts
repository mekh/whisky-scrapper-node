import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import {
  FlavorCandidateRow,
  ID,
  ProductCanonicalInput,
  ProductFillInput,
  ProductMatchRow,
  ProductNameCandidateRow,
  ProductScrapeFlavorLink,
  ProductStoreFieldsRow,
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
