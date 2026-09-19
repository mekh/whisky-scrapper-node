import { Injectable } from '@nestjs/common';

import {
  PRODUCER_ALIASES_MAX_PER_REQUEST,
  PRODUCER_PAGE_SIZE,
  PRODUCER_SLUG_MAX_LENGTH,
} from '~constants';
import { CoreProducerService } from '~core/producer';
import { ProducerAliasScope } from '~enums';
import { BadRequestError, DuplicateError, NotFoundError } from '~errors';
import type {
  ID,
  KbReconcileSummary,
  ProducerAliasWrite,
  ProducerCreateInput,
  ProducerCreateResult,
  ProducerCreateWrite,
  ProducerListQuery,
  ProducerOptionRow,
  ProducerOwnerRow,
  ProducerPatchResult,
  ProducerReviewRow,
  TypePaginated,
} from '~types';
import { KbKeyUtils } from '~utils';

import { KbReconcileService } from '~scrape/kb';

import { ProducerRuleFactory } from './producer-rule.factory';

import type { ProducerAliasInput } from './product-review.interfaces';

/**
 * How many rows a picker returns when the caller states no limit.
 */
const OPTION_DEFAULT_LIMIT = 20;

/**
 * Postgres unique-violation code, which a create meets only on a repeated
 * rule — the slug and the aliases resolve their own conflicts in SQL.
 */
const UNIQUE_VIOLATION = '23505';

/**
 * The read and write side of the producers section — the four kinds of maker
 * the knowledge base holds, as a catalogue a person browses and edits rather
 * than the work queue `/product/review` serves.
 *
 * Every write that changes what a bottling resolves to re-applies the
 * knowledge base in the same request, exactly as `patchProducer` does: a
 * stored claim changes nothing a filter reads until the catalogue is
 * re-resolved, and a person who has just linked a brand expects the link to
 * have happened.
 */
@Injectable()
export class ProducerService {
  private readonly producers: CoreProducerService;

  private readonly reconcile: KbReconcileService;

  private readonly rules: ProducerRuleFactory;

  public constructor(
    producers: CoreProducerService,
    reconcile: KbReconcileService,
    rules: ProducerRuleFactory,
  ) {
    this.producers = producers;
    this.reconcile = reconcile;
    this.rules = rules;
  }

  /**
   * Derives a stable kebab-case key from a display name.
   *
   * Built on `KbKeyUtils.key`, so it folds exactly what the alias index folds
   * — Latin accents, apostrophes, every other non-alphanumeric run — which is
   * what keeps a hand-typed producer's slug in the shape the seed's are.
   *
   * @param name - The display name.
   * @returns The slug, truncated to the column's width.
   */
  public static slugOf(name: string): string {
    return KbKeyUtils.key(name)
      .replace(/ /g, '-')
      .slice(0, PRODUCER_SLUG_MAX_LENGTH)
      .replace(/-+$/, '');
  }

  /**
   * Normalizes the spellings a new producer must answer to, the name's own
   * included, and drops the ones that fold to nothing.
   *
   * @param input - The producer as the request states it.
   * @returns The spellings to write, deduplicated and capped.
   */
  private static aliasWrites(
    input: ProducerCreateInput,
  ): ProducerAliasWrite[] {
    const spellings = [input.name, ...input.aliases ?? []];

    const keys = [
      ...new Set(
        spellings
          .map((spelling) => KbKeyUtils.key(spelling))
          .filter((key) => key.length > 0),
      ),
    ].slice(0, PRODUCER_ALIASES_MAX_PER_REQUEST + 1);

    return keys.map((key) => ({ key, scope: ProducerAliasScope.ANY }));
  }

  /**
   * Lists producers for the section's table.
   *
   * @param query - Kind, status and name filters plus sort and paging.
   * @returns A page of producers.
   */
  public async list(
    query: ProducerListQuery,
  ): Promise<TypePaginated<ProducerReviewRow>> {
    const limit = query.perPage ?? PRODUCER_PAGE_SIZE;
    const offset = ((query.page ?? 1) - 1) * limit;
    const { rows, total } = await this.producers.listPage(query);

    return { data: rows, total, limit, offset };
  }

  /**
   * Autocomplete behind the parent, bottler and link pickers.
   *
   * @param term - Substring of a name, slug or alias; blank offers the head of
   *   the list, which is what an untouched picker shows.
   * @param kind - Restrict to one kind, or omit for all.
   * @param limit - Rows to return at most.
   * @returns Matching producers, prefix matches first.
   */
  public async search(
    term?: string,
    kind?: string,
    limit?: number,
  ): Promise<ProducerOptionRow[]> {
    return this.producers.searchOptions(
      term && term.length > 0 ? term : null,
      kind ?? null,
      limit ?? OPTION_DEFAULT_LIMIT,
    );
  }

  /**
   * Autocomplete behind the owner field.
   *
   * The field stays **free text** — these are suggestions, not a closed
   * vocabulary. `producer.owner` is a plain column with no lookup table
   * behind it, and a person typing a company nobody has recorded yet is the
   * normal case rather than an error; the list only keeps them from spelling
   * an existing one three ways.
   *
   * @param term - Substring of the company name; blank answers the head of
   *   the list, which is what an untouched field shows.
   * @param limit - Rows to return at most.
   * @returns Distinct owners, prefix matches first.
   */
  public async owners(
    term?: string,
    limit?: number,
  ): Promise<ProducerOwnerRow[]> {
    return this.producers.searchOwners(
      term && term.length > 0 ? term : null,
      limit ?? OPTION_DEFAULT_LIMIT,
    );
  }

  /**
   * Creates one producer with its spellings and rules, **and applies it**.
   *
   * The name is always added as an alias alongside whatever spellings the
   * caller listed: a producer nothing resolves to is a row that changes
   * nothing, and typing the name twice is not a decision worth asking for.
   *
   * @param input - The producer to create, with its spellings and rules.
   * @returns The created row and what re-resolving the catalogue wrote.
   * @throws {BadRequestError} When the name yields no usable slug, a parent
   *   or bottler id names no producer, or a rule is malformed.
   * @throws {DuplicateError} When the slug is taken, or two rules state the
   *   same claim.
   */
  public async create(
    input: ProducerCreateInput,
  ): Promise<ProducerPatchResult> {
    const slug = input.slug
      ? ProducerService.slugOf(input.slug)
      : ProducerService.slugOf(input.name);

    if (!slug) {
      throw new BadRequestError('Producer name yields no slug');
    }

    await this.assertLinksExist(input.parentId, input.bottlerId);

    /**
     * Everything is validated before the write, so the transaction below can
     * only fail on the database's own constraints.
     */
    const rules = await this.rules.buildMany(input.rules ?? []);
    const aliases = ProducerService.aliasWrites(input);

    const created = await this.writeProducer({
      producer: input,
      slug,
      aliases,
      rules,
    });

    if (!created) {
      throw new DuplicateError(`Producer ${slug} already exists`);
    }

    const run = await this.reconcile.run();

    return {
      producer: created.producer,
      applied: run.summary,
      skippedAliases: created.skippedAliases,
    };
  }

  /**
   * Points one shop spelling at a producer **and applies it**.
   *
   * This is what the facts queue's "Producer not resolved" action writes, and
   * an alias rather than a per-bottling link on purpose: the resolver matches
   * a bottling through `producer_alias`, so one alias fixes every bottling
   * carrying that spelling, and the country and type then flow from the
   * knowledge base — which is what takes the rows out of the queue.
   *
   * @param id - The producer to point at.
   * @param input - The spelling and its scope.
   * @returns What re-resolving the catalogue wrote.
   * @throws {NotFoundError} When no producer has that id.
   * @throws {BadRequestError} When the spelling normalizes to nothing.
   * @throws {DuplicateError} When another producer already claims the key.
   */
  public async linkAlias(
    id: ID,
    input: ProducerAliasInput,
  ): Promise<KbReconcileSummary> {
    const producer = await this.producers.findReviewRow(id);

    if (!producer) {
      throw new NotFoundError('Producer not found');
    }

    const key = KbKeyUtils.key(input.brand);

    if (!key) {
      throw new BadRequestError('Alias matches nothing once normalized');
    }

    const written = await this.producers.addAlias(
      key,
      id,
      input.scope ?? ProducerAliasScope.ANY,
      input.note ?? null,
    );

    if (!written) {
      await this.assertAliasIsOurs(key, id);
    }

    const run = await this.reconcile.run();

    return run.summary;
  }

  /**
   * Widens or narrows one spelling **and applies the change**.
   *
   * The one-click «→ на початку назви» of the producer modal, and the reason
   * the `lead` scope exists at all: a four-letter maker such as `Hyde` can
   * only ever be brand-scoped, so the eleven bottlings of a shop that states
   * no brand are unreachable until somebody widens it — with the two numbers
   * of the impact preview in front of them.
   *
   * @param id - The producer the alias must belong to.
   * @param aliasId - The alias to rescope.
   * @param scope - The scope to store.
   * @returns What re-resolving the catalogue wrote.
   * @throws {NotFoundError} When the alias is not that producer's.
   */
  public async setAliasScope(
    id: ID,
    aliasId: ID,
    scope: ProducerAliasScope,
  ): Promise<KbReconcileSummary> {
    const written = await this.producers.setAliasScope(aliasId, id, scope);

    if (!written) {
      throw new NotFoundError('Alias not found');
    }

    const run = await this.reconcile.run();

    return run.summary;
  }

  /**
   * Removes one spelling **and applies the removal**.
   *
   * @param id - The producer the alias must belong to.
   * @param aliasId - The alias to remove.
   * @returns What re-resolving the catalogue wrote.
   * @throws {NotFoundError} When the alias is not that producer's.
   */
  public async unlinkAlias(
    id: ID,
    aliasId: ID,
  ): Promise<KbReconcileSummary> {
    const removed = await this.producers.removeAlias(aliasId, id);

    if (!removed) {
      throw new NotFoundError('Alias not found');
    }

    const run = await this.reconcile.run();

    return run.summary;
  }

  /**
   * Refuses a link that names a producer nobody has.
   *
   * A foreign key would refuse it too, as a 500; this answers 400 and says
   * which of the two fields is wrong.
   *
   * @param parentId - The proposed parent, or undefined.
   * @param bottlerId - The proposed bottler, or undefined.
   * @throws {BadRequestError} When either id names no producer.
   */
  private async assertLinksExist(
    parentId?: ID,
    bottlerId?: ID,
  ): Promise<void> {
    const ids = [parentId, bottlerId].filter((id): id is ID => Boolean(id));

    if (!ids.length) {
      return;
    }

    const existing = await this.producers.findExistingIds(ids);

    if (parentId && !existing.has(parentId)) {
      throw new BadRequestError('Parent producer not found');
    }

    if (bottlerId && !existing.has(bottlerId)) {
      throw new BadRequestError('Bottler producer not found');
    }
  }

  /**
   * Writes the row, its spellings and its rules in one transaction, naming
   * the duplicate claim a `23505` stands for here.
   *
   * @param write - What the create writes.
   * @returns The created row, or null when the slug is taken.
   * @throws {DuplicateError} When two rules state the same pattern and tag.
   */
  private async writeProducer(
    write: ProducerCreateWrite,
  ): Promise<ProducerCreateResult | null> {
    try {
      return await this.producers.createProducer(write);
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new DuplicateError(
          'Two rules of this producer state the same pattern and claim',
        );
      }

      throw error;
    }
  }

  /**
   * Turns a refused alias write into the right answer: silence when this
   * producer already had the spelling, a conflict when another one holds it.
   *
   * @param key - The normalized alias key.
   * @param id - The producer the caller aimed at.
   * @throws {DuplicateError} When another producer claims the key.
   */
  private async assertAliasIsOurs(key: string, id: ID): Promise<void> {
    const owner = await this.producers.findAliasOwner(key);

    if (owner && owner.producerId !== id) {
      throw new DuplicateError(`"${key}" already resolves to ${owner.name}`);
    }
  }
}
