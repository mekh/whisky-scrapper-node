import { Injectable } from '@nestjs/common';
import { Transactional } from 'typeorm-transactional';

import {
  KB_PEAT_TAGS,
  PRODUCER_ISSUE_SEVERITY,
  REVIEW_PAGE_SIZE,
} from '~constants';
import { CoreBaseService } from '~core/_common';
import { ProducerIssueCode, ProducerKind } from '~enums';
import { ServerError } from '~errors';
import {
  ID,
  KbAliasEntry,
  KbFlavorRule,
  KbIndex,
  KbPeatFlavorIds,
  KbProducerFlavor,
  ProducerAliasWrite,
  ProducerConflict,
  ProducerDetail,
  ProducerListQuery,
  ProducerOptionRow,
  ProducerOwnerRow,
  ProducerQueueHints,
  ProducerQueueQuery,
  ProducerQueueRow,
  ProducerReviewRow,
  ProducerRuleDraft,
  ProducerRuleInput,
  ResearchedProducer,
  ReviewProducerSummary,
  TypeBrand,
  UnresearchedBrandRow,
  UnresolvedBrandRow,
} from '~types';

import type { ProducerCreateResult, ProducerCreateWrite } from '~types';

import { KbAliasUtils } from '~utils';

import { ProducerEntity } from './producer.entity';
import { ProducerRepository } from './producer.repository';

import type { ProducerReviewPatch } from './producer-review.interfaces';
import type { ProducerCandidateFactRow } from './producer.interfaces';

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
   * @returns The alias index, every live producer's facts by id, the rules,
   *   the house-style statements and the two peat tag ids.
   */
  public async loadIndex(): Promise<KbIndex> {
    const [aliases, producers, rules, producerFlavors, peatFlavorIds] =
      await Promise.all([
        this.repo.findAliasIndex(),
        this.repo.findProducerFacts(),
        this.repo.findRules(),
        this.repo.findProducerFlavors(),
        this.repo.findPeatFlavorIds(KB_PEAT_TAGS.peated, KB_PEAT_TAGS.smoky),
      ]);

    return {
      aliases: KbAliasUtils.usable(aliases),
      producers,
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
   * Creates one producer with its spellings and its rules, in one
   * transaction: a rule is scoped to a producer id that exists only once the
   * row is written, and a half-written maker is worse than none.
   *
   * @param write - The row, its slug, its spellings and its rules, all
   *   already validated and normalized by the domain layer.
   * @returns The created row and the spellings another producer holds, or
   *   null when the slug is taken.
   * @throws {ServerError} When the row cannot be read back, which the
   *   transaction makes impossible.
   */
  @Transactional()
  public async createProducer(
    write: ProducerCreateWrite,
  ): Promise<ProducerCreateResult | null> {
    const id = await this.repo.insertProducer(write.producer, write.slug);

    if (!id) {
      return null;
    }

    const skippedAliases = await this.attachAliases(id, write.aliases);

    await this.attachRules(id, write.rules);

    const producer = await this.repo.findOneForReview(id);

    if (!producer) {
      throw new ServerError('The created producer could not be read back');
    }

    return { producer, skippedAliases };
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
   * Finds which producer already holds a slug.
   *
   * @param slug - The slug a create asked for.
   * @returns The holder, or null when the slug is free.
   */
  public async findSlugOwner(slug: string): Promise<ProducerConflict | null> {
    return this.repo.findSlugOwner(slug);
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
   * One producer's kind, for a caller that only needs to branch on it.
   *
   * @param id - The producer.
   * @returns The kind, or null when nothing has that id.
   */
  public async findKind(id: ID): Promise<ProducerKind | null> {
    return this.repo.findKind(id);
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
   * Loads the alias index of the producers somebody has ruled out, for the
   * curation screen's what-if pass. Never for resolution — see
   * {@link ProducerRepository.findRejectedAliasIndex}.
   *
   * @returns Alias entries whose producers are `rejected`.
   */
  public async loadRejectedAliasIndex(): Promise<KbAliasEntry[]> {
    const aliases = await this.repo.findRejectedAliasIndex();

    return KbAliasUtils.usable(aliases);
  }

  /**
   * Lists one page of the producers queue, each row carrying why it is there.
   *
   * The severity of each code is added here rather than in SQL, from the same
   * map the client colours its chips by, and the mention count comes from the
   * what-if pass that produced the hints — neither belongs in a predicate.
   *
   * @param query - Issue, status, kind, search and paging.
   * @param hints - What the what-if pass concluded about the producers.
   * @returns The page and the total matching count.
   */
  public async findQueue(
    query: ProducerQueueQuery,
    hints: ProducerQueueHints,
  ): Promise<{ rows: ProducerQueueRow[]; total: number }> {
    const limit = query.perPage ?? REVIEW_PAGE_SIZE;
    const offset = ((query.page ?? 1) - 1) * limit;

    const { rows, total } = await this.repo.findQueue(
      query,
      hints.unreachable,
      hints.mentioned,
      limit,
      offset,
    );

    return {
      rows: rows.map((row) => ({
        ...row,
        unresolvedMentions: hints.mentions.get(row.id) ?? 0,
        potentialReach: null,
        issues: row.issues.map((code) => ({
          code: code as ProducerIssueCode,
          severity: PRODUCER_ISSUE_SEVERITY[code as ProducerIssueCode],
        })),
      })),
      total,
    };
  }

  /**
   * Counts the producers queue, by code.
   *
   * @param hints - What the what-if pass concluded about the producers.
   * @returns The open total and the per-code tally.
   */
  public async countQueueIssues(
    hints: ProducerQueueHints,
  ): Promise<ReviewProducerSummary> {
    return this.repo.countQueueIssues(hints.unreachable, hints.mentioned);
  }

  /**
   * The facts a suggested producer is judged by, for a handful of ids.
   *
   * @param ids - The producers to describe.
   * @returns One row per producer that exists.
   */
  public async findCandidateFacts(
    ids: ID[],
  ): Promise<ProducerCandidateFactRow[]> {
    return this.repo.findCandidateFacts(ids);
  }

  /**
   * The producer one alias row belongs to, and the spelling it holds.
   *
   * @param aliasId - The alias.
   * @returns The producer, the key and the scope, or null.
   */
  public async findAliasProducer(
    aliasId: ID,
  ): Promise<{ producerId: ID; key: string; scope: string } | null> {
    return this.repo.findAliasProducer(aliasId);
  }

  /**
   * Widens or narrows one alias, scoped to its producer.
   *
   * @param aliasId - The alias.
   * @param producerId - The producer it must belong to.
   * @param scope - The scope to store.
   * @returns How many rows were written.
   */
  public async setAliasScope(
    aliasId: ID,
    producerId: ID,
    scope: string,
  ): Promise<number> {
    return this.repo.updateAliasScope(aliasId, producerId, scope);
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

  /**
   * Points every spelling of a create at the new row, skipping the keys
   * another producer already claims.
   *
   * A taken key is skipped rather than refused: the person asked for a row
   * and one duplicate spelling is no reason to leave them without one.
   *
   * @param id - The new producer.
   * @param aliases - The normalized spellings with their scope.
   * @returns The keys another producer holds.
   */
  private async attachAliases(
    id: ID,
    aliases: ProducerAliasWrite[],
  ): Promise<string[]> {
    const skipped: string[] = [];

    for (const alias of aliases) {
      const written = await this.repo.insertAlias(alias.key, id, alias.scope);

      if (!written) {
        skipped.push(alias.key);
      }
    }

    return skipped;
  }

  /**
   * Stores the rules of a create, stamped with the row that now exists.
   *
   * @param id - The new producer.
   * @param rules - The validated rules.
   * @returns Resolves once every rule is written.
   * @throws {QueryFailedError} With driver code `23505` when two rules state
   *   the same pattern and tag.
   */
  private async attachRules(
    id: ID,
    rules: ProducerRuleDraft[],
  ): Promise<void> {
    for (const rule of rules) {
      await this.repo.insertRule({ ...rule, producerId: id });
    }
  }
}
