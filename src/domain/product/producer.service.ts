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
  ProducerCreateInput,
  ProducerListQuery,
  ProducerOptionRow,
  ProducerOwnerRow,
  ProducerPatchResult,
  ProducerReviewRow,
  TypePaginated,
} from '~types';
import { KbKeyUtils } from '~utils';

import { KbReconcileService } from '~scrape/kb';

import type { ProducerAliasInput } from './product-review.interfaces';

/**
 * How many rows a picker returns when the caller states no limit.
 */
const OPTION_DEFAULT_LIMIT = 20;

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

  public constructor(
    producers: CoreProducerService,
    reconcile: KbReconcileService,
  ) {
    this.producers = producers;
    this.reconcile = reconcile;
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
   * Creates one producer **and applies it**.
   *
   * The name is always added as an alias alongside whatever spellings the
   * caller listed: a producer nothing resolves to is a row that changes
   * nothing, and typing the name twice is not a decision worth asking for.
   *
   * @param input - The producer to create.
   * @returns The created row and what re-resolving the catalogue wrote.
   * @throws {BadRequestError} When the name yields no usable slug, or a
   *   parent or bottler id names no producer.
   * @throws {DuplicateError} When the slug is already taken.
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

    const created = await this.producers.createProducer(input, slug);

    if (!created) {
      throw new DuplicateError(`Producer ${slug} already exists`);
    }

    await this.attachAliases(created.id, [input.name, ...input.aliases ?? []]);

    const run = await this.reconcile.run();

    return { producer: created, applied: run.summary };
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
   * Adds the spellings a new producer must answer to, skipping the ones
   * another producer already claims.
   *
   * A taken key is skipped rather than refused: the create has already
   * happened, and failing it over one duplicate spelling would leave the
   * person with no row and no obvious way to retry.
   *
   * @param id - The new producer.
   * @param spellings - The raw spellings, normalized here.
   */
  private async attachAliases(id: ID, spellings: string[]): Promise<void> {
    const keys = [
      ...new Set(
        spellings
          .map((spelling) => KbKeyUtils.key(spelling))
          .filter((key) => key.length > 0),
      ),
    ].slice(0, PRODUCER_ALIASES_MAX_PER_REQUEST + 1);

    await Promise.all(
      keys.map((key) =>
        this.producers.addAlias(key, id, ProducerAliasScope.ANY)
      ),
    );
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
