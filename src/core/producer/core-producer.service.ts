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
  ProducerCreateInput,
  ProducerDetail,
  ProducerListQuery,
  ProducerOptionRow,
  ProducerOwnerRow,
  ProducerReviewRow,
  ProducerRuleInput,
  ResearchedProducer,
  TypeBrand,
  UnresearchedBrandRow,
  UnresolvedBrandRow,
} from '~types';

import { KbAliasUtils } from '~utils';

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
   * Every index this service hands out is passed through
   * `KbAliasUtils.usable` first, so an alias that names a category rather
   * than a producer can never reach a matcher — see the note there for the
   * `& Whisky` case that motivated it.
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

    return {
      aliases: KbAliasUtils.usable(aliases),
      rules,
      producerFlavors,
      peatFlavorIds,
    };
  }

  /**
   * The alias match index on its own, for callers that only resolve producers
   * (the review screen's unresolved-brand listing).
   *
   * @returns Alias entries, longest key first.
   */
  public async loadAliasIndex(): Promise<KbAliasEntry[]> {
    const aliases = await this.repo.findAliasIndex();

    return KbAliasUtils.usable(aliases);
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

    const [children, rules, aliases] = await Promise.all([
      this.repo.findChildren(id),
      this.repo.findRulesForReview(id),
      this.repo.findAliases(id),
    ]);

    return {
      producer,
      children,
      rules: rules.rules,
      globalPeatRules: rules.globalPeatRules,
      aliases,
    };
  }

  /**
   * Lists producers for the CRUD section, with the caller's own ordering.
   *
   * @param query - Kind, status and name filters plus sort and paging.
   * @returns The page's rows and the total matching count.
   */
  public async listPage(
    query: ProducerListQuery,
  ): Promise<{ rows: ProducerReviewRow[]; total: number }> {
    return this.repo.findPage(query);
  }

  /**
   * Creates one producer.
   *
   * @param input - The producer to create.
   * @param slug - The slug to store, already derived and normalized.
   * @returns The created row, or null when the slug is taken.
   */
  public async createProducer(
    input: ProducerCreateInput,
    slug: string,
  ): Promise<ProducerReviewRow | null> {
    const id = await this.repo.insertProducer(input, slug);

    if (!id) {
      return null;
    }

    return this.repo.findOneForReview(id);
  }

  /**
   * Points one normalized spelling at a producer.
   *
   * @param key - The normalized alias key.
   * @param producerId - The producer it must reach.
   * @param scope - Where the alias may be matched.
   * @param note - Why it exists, or null.
   * @returns True when the alias was written, false when the key was taken.
   */
  public async addAlias(
    key: string,
    producerId: ID,
    scope: string,
    note: string | null = null,
  ): Promise<boolean> {
    return this.repo.insertAlias(key, producerId, scope, note);
  }

  /**
   * Deletes one alias, scoped to its producer.
   *
   * @param aliasId - The alias to delete.
   * @param producerId - The producer it must belong to.
   * @returns How many rows were deleted.
   */
  public async removeAlias(aliasId: ID, producerId: ID): Promise<number> {
    return this.repo.deleteAlias(aliasId, producerId);
  }

  /**
   * Finds which producer a normalized key already resolves to.
   *
   * @param key - The normalized alias key.
   * @returns The owner's id and name, or null when nothing claims the key.
   */
  public async findAliasOwner(
    key: string,
  ): Promise<{ producerId: ID; name: string } | null> {
    return this.repo.findAliasOwner(key);
  }

  /**
   * Autocomplete for the parent, bottler and link pickers.
   *
   * @param term - Substring of a name, slug or alias; null offers the head of
   *   the whole list.
   * @param kind - Restrict to one kind, or null for all.
   * @param limit - Rows to return at most.
   * @returns Matching producers, prefix matches first.
   */
  public async searchOptions(
    term: string | null,
    kind: string | null,
    limit: number,
  ): Promise<ProducerOptionRow[]> {
    return this.repo.searchOptions(term, kind, limit);
  }

  /**
   * Lists the distinct owning companies matching a term.
   *
   * @param term - Substring of the company name, matched case-insensitively;
   *   null answers the head of the list.
   * @param limit - Rows to return at most.
   * @returns Distinct owners, prefix matches first.
   */
  public async searchOwners(
    term: string | null,
    limit: number,
  ): Promise<ProducerOwnerRow[]> {
    return this.repo.findOwners(term, limit);
  }

  /**
   * Narrows a set of ids to the ones that exist.
   *
   * @param ids - The ids to check.
   * @returns The subset that exists.
   */
  public async findExistingIds(ids: ID[]): Promise<Set<ID>> {
    return this.repo.findExistingIds(ids);
  }

  /**
   * Lists producers for the review screen.
   *
   * @param status - Restrict to one review status, or omit for all.
   * @param limit - Page size; `null` returns every matching row.
   * @param offset - Page offset.
   * @param search - Case-insensitive substring of the name or slug.
   * @returns The rows and the total matching count.
   */
  public async listForReview(
    status?: string,
    limit?: number | null,
    offset?: number,
    search?: string,
  ): Promise<{ rows: ProducerReviewRow[]; total: number }> {
    return this.repo.findForReview(status, limit, offset, search);
  }

  /**
   * Reads one producer as a review row, without the detail payload.
   *
   * @param id - The producer to read.
   * @returns The row, or null when no producer has that id.
   */
  public async findReviewRow(id: ID): Promise<ProducerReviewRow | null> {
    return this.repo.findOneForReview(id);
  }

  /**
   * Inserts one producer-scoped name-pattern rule.
   *
   * @param input - The validated, normalized rule.
   * @returns Resolves once the row is written.
   */
  public async createRule(input: ProducerRuleInput): Promise<void> {
    return this.repo.insertRule(input);
  }

  /**
   * Deletes one rule, scoped to its producer.
   *
   * @param ruleId - The rule to delete.
   * @param producerId - The producer it must belong to.
   * @returns How many rows were deleted.
   */
  public async deleteRule(ruleId: ID, producerId: ID): Promise<number> {
    return this.repo.deleteRule(ruleId, producerId);
  }

  /**
   * Loads the alias index of the withheld producers, for the review screen's
   * reach ranking. Never for resolution — see
   * {@link ProducerRepository.findWithheldAliasIndex}.
   *
   * @returns Alias entries whose producers are `unverified`.
   */
  public async loadWithheldAliasIndex(): Promise<KbAliasEntry[]> {
    const aliases = await this.repo.findWithheldAliasIndex();

    return KbAliasUtils.usable(aliases);
  }

  /**
   * Autocomplete over producer names, matched through their aliases.
   *
   * @param term - The substring to look for.
   * @param limit - Rows to return at most.
   * @returns Matching producer names, best matches first.
   */
  public async searchByName(
    term: string,
    limit: number,
  ): Promise<TypeBrand[]> {
    return this.repo.searchByName(term, limit);
  }

  /**
   * Resolves producer names to ids without creating the missing ones.
   *
   * @param names - Producer names; blanks and duplicates are ignored.
   * @returns Map from each matched name to its id; unknown names are absent.
   */
  public async findIdsByName(names: string[]): Promise<Map<string, ID>> {
    return this.repo.findIdsByName(names);
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
