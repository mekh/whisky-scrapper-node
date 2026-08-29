import { Injectable } from '@nestjs/common';

import { KB_PEAT_TAGS } from '~constants';
import { CoreBaseService } from '~core/_common';
import {
  ID,
  KbAliasEntry,
  KbFlavorRule,
  KbIndex,
  KbPeatFlavorIds,
  KbProducerFlavor,
  ProducerDetail,
  ProducerReviewRow,
  ResearchedProducer,
  UnresearchedBrandRow,
  UnresolvedBrandRow,
} from '~types';

import { ProducerEntity } from './producer.entity';
import { ProducerRepository } from './producer.repository';

import type { ProducerReviewPatch } from './producer-review.interfaces';

/**
 * Persistence-layer public API for the knowledge base.
 *
 * One service fronts all four tables (`producer`, `producer_alias`,
 * `producer_flavor`, `flavor_rule`) because they are one aggregate: a
 * producer's aliases and rules have no meaning apart from it, and every read
 * loads them together as a match index. `ProductRepository` owns
 * `product_flavor` the same way.
 */
@Injectable()
export class CoreProducerService extends CoreBaseService<ProducerEntity> {
  protected readonly uniqueFields: 'slug'[] = ['slug'];

  public constructor(protected readonly repo: ProducerRepository) {
    super(repo);
  }

  /**
   * Loads everything the resolver matches against.
   *
   * Read fresh per call rather than cached on this singleton: stores sync
   * concurrently and a review can change the knowledge base between runs, so a
   * cached index would resolve against facts someone had already corrected.
   *
   * @returns The alias index, the rules, the house-style statements and the
   *   two peat tag ids.
   */
  public async loadIndex(): Promise<KbIndex> {
    const [aliases, rules, producerFlavors, peatFlavorIds] = await Promise.all([
      this.repo.findAliasIndex(),
      this.repo.findRules(),
      this.repo.findProducerFlavors(),
      this.repo.findPeatFlavorIds(KB_PEAT_TAGS.peated, KB_PEAT_TAGS.smoky),
    ]);

    return { aliases, rules, producerFlavors, peatFlavorIds };
  }

  /**
   * The alias match index on its own, for callers that only resolve producers
   * (the review screen's unresolved-brand listing).
   *
   * @returns Alias entries, longest key first.
   */
  public async loadAliasIndex(): Promise<KbAliasEntry[]> {
    return this.repo.findAliasIndex();
  }

  /**
   * The name-pattern rules on their own.
   *
   * @returns Rules, best-matching first.
   */
  public async loadRules(): Promise<KbFlavorRule[]> {
    return this.repo.findRules();
  }

  /**
   * The curated house-style statements on their own.
   *
   * @returns Map from producer id to its statements.
   */
  public async loadProducerFlavors(): Promise<Map<ID, KbProducerFlavor[]>> {
    return this.repo.findProducerFlavors();
  }

  /**
   * The `peated` and `smoky` tag ids.
   *
   * @returns Both ids; either is null when the tag row is missing.
   */
  public async loadPeatFlavorIds(): Promise<KbPeatFlavorIds> {
    return this.repo.findPeatFlavorIds(
      KB_PEAT_TAGS.peated,
      KB_PEAT_TAGS.smoky,
    );
  }

  /**
   * Lists brands that have never been researched, worst-first.
   *
   * @param limit - How many to return.
   * @returns Brand names with product counts and sample names.
   */
  public async listUnresearchedBrands(
    limit?: number,
  ): Promise<UnresearchedBrandRow[]> {
    return this.repo.findUnresearchedBrands(limit);
  }

  /**
   * Stores one researched producer and the alias that reaches it.
   *
   * @param row - The producer to store.
   * @param aliasKey - The normalized brand key.
   * @param aliasScope - Where the alias may be matched.
   * @returns True when a new producer row was created.
   */
  public async saveResearched(
    row: ResearchedProducer,
    aliasKey: string,
    aliasScope: string,
  ): Promise<boolean> {
    return this.repo.saveResearched(row, aliasKey, aliasScope);
  }

  /**
   * Applies a reviewer's edit and stamps the row confirmed.
   *
   * @param id - The producer to edit.
   * @param patch - The fields to change; an absent field is left alone.
   * @returns The updated row, or null when no producer has that id.
   */
  public async applyReview(
    id: ID,
    patch: ProducerReviewPatch,
  ): Promise<ProducerReviewRow | null> {
    const updated = await this.repo.applyReview(id, patch);

    if (!updated) {
      return null;
    }

    return this.repo.findOneForReview(id);
  }

  /**
   * Reads everything a reviewer needs to judge one producer.
   *
   * The row alone is not enough: `peatProfile` states the **core range**, and
   * every exception lives either in a child row or in a rule. Composing the
   * three here rather than in the domain layer keeps the review screen's one
   * question — "what actually decides this bottling's peat?" — answered by one
   * call.
   *
   * @param id - The producer to read.
   * @returns The producer with its children and rules, or null when no
   *   producer has that id.
   */
  public async findDetail(id: ID): Promise<ProducerDetail | null> {
    const producer = await this.repo.findOneForReview(id);

    if (!producer) {
      return null;
    }

    const [children, rules] = await Promise.all([
      this.repo.findChildren(id),
      this.repo.findRulesForReview(id),
    ]);

    return {
      producer,
      children,
      rules: rules.rules,
      globalPeatRules: rules.globalPeatRules,
    };
  }

  /**
   * Lists producers for the review screen.
   *
   * @param status - Restrict to one review status, or omit for all.
   * @param limit - Page size; `null` returns every matching row.
   * @param offset - Page offset.
   * @returns The rows and the total matching count.
   */
  public async listForReview(
    status?: string,
    limit?: number | null,
    offset?: number,
  ): Promise<{ rows: ProducerReviewRow[]; total: number }> {
    return this.repo.findForReview(status, limit, offset);
  }

  /**
   * Loads the alias index of the withheld producers, for the review screen's
   * reach ranking. Never for resolution — see
   * {@link ProducerRepository.findWithheldAliasIndex}.
   *
   * @returns Alias entries whose producers are `unverified`.
   */
  public async loadWithheldAliasIndex(): Promise<KbAliasEntry[]> {
    return this.repo.findWithheldAliasIndex();
  }

  /**
   * Counts producers by review status.
   *
   * @returns One entry per status present.
   */
  public async countByStatus(): Promise<Record<string, number>> {
    return this.repo.countByStatus();
  }

  /**
   * Lists the brand keys nothing resolves, worst-first.
   *
   * @param limit - How many to return.
   * @returns Brand names with the number of bottlings behind them.
   */
  public async listUnresolvedBrands(
    limit?: number,
  ): Promise<UnresolvedBrandRow[]> {
    return this.repo.findUnresolvedBrands(limit);
  }

  /**
   * Resolves whisky type names to their FK ids.
   *
   * @param names - Type names to resolve.
   * @returns Map from name to id; unknown names are absent.
   */
  public async resolveTypeIds(names: string[]): Promise<Map<string, ID>> {
    return this.repo.findTypeIdsByName(names);
  }
}
