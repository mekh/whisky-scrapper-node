import { Injectable } from '@nestjs/common';

import { REVIEW_AFFECTED_LIMIT } from '~constants';
import { CoreProducerService } from '~core/producer';
import { CoreProductService } from '~core/product';
import { FactSource, ProducerAliasScope, ProductReviewStatus } from '~enums';
import { BadRequestError, NotFoundError } from '~errors';
import type {
  ID,
  KbAliasEntry,
  KbApplyPlan,
  KbIndex,
  KbReconcileRow,
  ReviewAffected,
  ReviewAffectedChanges,
  ReviewAliasScopeReach,
  ReviewPreview,
  ReviewProducerLink,
} from '~types';
import { KbKeyUtils } from '~utils';

import { KbApplyService } from '~scrape/kb';

/**
 * The scopes an alias may be given, in the order the binding block offers
 * them: narrowest first, so the person reads the safe option before the wide
 * one. `name` is deliberately absent — it is the one scope that cannot also
 * match a stated brand, and nothing on this screen wants that.
 */
const OFFERED_SCOPES: readonly ProducerAliasScope[] = [
  ProducerAliasScope.BRAND,
  ProducerAliasScope.LEAD,
  ProducerAliasScope.ANY,
];

/**
 * What an action would do to the catalogue, before it is taken.
 *
 * The owner's rule for this screen: **before committing, the person sees how
 * many other bottlings the action touches, which ones, and what happens to
 * each.** Many fixes here reach far beyond the row being edited — an alias
 * reaches every bottling that carries the spelling, and a producer's own
 * facts flow into everything resolved to it — and the difference between a
 * good alias and a bad one is exactly those numbers.
 *
 * The mechanism already existed: `ProducerReachService` builds a hypothetical
 * alias index and re-resolves the whole catalogue in about 130 ms. This feeds
 * the same pass the action the person is about to take, and diffs the plan
 * against the stored rows.
 *
 * It writes nothing and bumps nothing.
 */
@Injectable()
export class ReviewPreviewService {
  private readonly producers: CoreProducerService;

  private readonly products: CoreProductService;

  private readonly apply: KbApplyService;

  public constructor(
    producers: CoreProducerService,
    products: CoreProductService,
    apply: KbApplyService,
  ) {
    this.producers = producers;
    this.products = products;
    this.apply = apply;
  }

  /**
   * Works out what one producer action would change.
   *
   * A `pin` is answered without a pass at all: `SET_PRODUCERS_SQL` skips a
   * `manual` link, so a pin reaches exactly one bottling by construction and
   * running the catalogue through the resolver would only confirm it.
   *
   * @param productId - The bottling being edited, which is always counted
   *   among the ones the action frees.
   * @param link - The action.
   * @returns The bottlings it would change, the two numbers the binding block
   *   states, and — for an alias — the same two per scope.
   * @throws {BadRequestError} When the action names no producer, or a
   *   spelling that normalizes to nothing.
   */
  public async previewLink(
    productId: ID,
    link: ReviewProducerLink,
  ): Promise<ReviewPreview> {
    if (link.mode === 'pin') {
      return ReviewPreviewService.pinPreview();
    }

    const [index, rows, producerId, spelling] = await Promise.all([
      this.producers.loadIndex(),
      this.products.findKbReconcileCandidates(),
      this.resolveTargetProducer(link),
      this.resolveSpelling(link),
    ]);

    const facts = index.aliases
      .find((alias) => alias.producer.id === producerId)?.producer
      ?? null;

    if (!facts) {
      throw new BadRequestError(
        'The producer has no alias, so nothing can resolve to it yet',
      );
    }

    const scopes: Record<string, ReviewAliasScopeReach> = {};
    let chosen: ReviewAffected[] = [];
    let chosenTotal = 0;

    const wanted = (link.scope as ProducerAliasScope | undefined)
      ?? ProducerAliasScope.LEAD;

    for (const scope of OFFERED_SCOPES) {
      const aliases = ReviewPreviewService.hypothetical(
        index.aliases,
        { key: spelling, scope, producer: facts },
        link.aliasId ? spelling : null,
      );

      const affected = await this.runPass(index, aliases, rows, productId);

      scopes[scope] = ReviewPreviewService.reachOf(affected, rows);

      if (scope === wanted) {
        chosenTotal = affected.length;
        chosen = affected.slice(0, REVIEW_AFFECTED_LIMIT);
      }
    }

    return {
      affected: chosen,
      affectedTotal: chosenTotal,
      reach: scopes[wanted] ?? { frees: 0, steals: 0 },
      aliasScopes: scopes,
    };
  }

  /**
   * Works out what removing one spelling would cost.
   *
   * The number beside «Видалити»: how many bottlings would stop resolving to
   * the producer and come back to the queue. A delete is the one action on
   * this screen whose reach is entirely destructive, so it is the one that
   * most needs stating.
   *
   * Scoped to the producer, so a stray id cannot ask about another maker's
   * spelling — the rule every alias route here already follows.
   *
   * @param producerId - The producer the alias must belong to.
   * @param aliasId - The spelling to remove.
   * @returns The bottlings it would unlink, and how many.
   * @throws {NotFoundError} When the alias is not that producer's.
   */
  public async previewAliasRemoval(
    producerId: ID,
    aliasId: ID,
  ): Promise<ReviewPreview> {
    const owner = await this.ownedAlias(producerId, aliasId);

    const [index, rows] = await Promise.all([
      this.producers.loadIndex(),
      this.products.findKbReconcileCandidates(),
    ]);

    const aliases = index.aliases.filter((alias) =>
      alias.key !== owner.key || alias.producer.id !== owner.producerId
    );

    return this.previewIndex(index, aliases, rows);
  }

  /**
   * Works out what one spelling would reach under another scope.
   *
   * The number beside «→ на початку назви» on the producer card, answered
   * without a bottling in focus: the binding block asks the same question
   * through `previewLink`, but the card has no `productId` to hand it, and
   * the owner's rule is that no button that touches other bottlings goes
   * unnumbered. The pass is the same one the binding block runs — the live
   * index with this spelling's scope replaced — so the two screens cannot
   * state different numbers for one action.
   *
   * @param producerId - The producer the alias must belong to.
   * @param aliasId - The spelling to rescope.
   * @param scope - The scope it would be given.
   * @returns The bottlings the rescope would change, and the two numbers.
   * @throws {NotFoundError} When the alias is not that producer's.
   * @throws {BadRequestError} When the producer is not in the live index —
   *   withheld or rejected, so no scope can make anything resolve to it.
   */
  public async previewAliasRescope(
    producerId: ID,
    aliasId: ID,
    scope: ProducerAliasScope,
  ): Promise<ReviewPreview> {
    const owner = await this.ownedAlias(producerId, aliasId);

    const [index, rows] = await Promise.all([
      this.producers.loadIndex(),
      this.products.findKbReconcileCandidates(),
    ]);

    const facts = index.aliases
      .find((alias) => alias.producer.id === producerId)?.producer
      ?? null;

    if (!facts) {
      throw new BadRequestError(
        'The producer is not live, so no scope makes anything resolve to it',
      );
    }

    const aliases = ReviewPreviewService.hypothetical(
      index.aliases,
      { key: owner.key, scope, producer: facts },
      owner.key,
    );

    return this.previewIndex(index, aliases, rows);
  }

  /**
   * Finds one spelling and checks it belongs to the producer named in the
   * route, so a stray id cannot ask about another maker's spelling.
   *
   * @param producerId - The producer the alias must belong to.
   * @param aliasId - The spelling.
   * @returns The spelling's owner, key and scope.
   * @throws {NotFoundError} When the alias is not that producer's.
   */
  private async ownedAlias(
    producerId: ID,
    aliasId: ID,
  ): Promise<{ producerId: ID; key: string; scope: string }> {
    const owner = await this.producers.findAliasProducer(aliasId);

    if (!owner || owner.producerId !== producerId) {
      throw new NotFoundError('Alias not found');
    }

    return owner;
  }

  /**
   * Answers a preview for a hypothetical index with no bottling in focus.
   *
   * @param index - The live knowledge base.
   * @param aliases - The index to resolve against instead of the live one.
   * @param rows - The catalogue as stored.
   * @returns The bottlings that would change, capped, and the two numbers.
   */
  private async previewIndex(
    index: KbIndex,
    aliases: KbAliasEntry[],
    rows: KbReconcileRow[],
  ): Promise<ReviewPreview> {
    const affected = await this.runPass(index, aliases, rows, null);

    return {
      affected: affected.slice(0, REVIEW_AFFECTED_LIMIT),
      affectedTotal: affected.length,
      reach: ReviewPreviewService.reachOf(affected, rows),
    };
  }

  /**
   * Resolves the whole catalogue against a hypothetical index and diffs the
   * result against what is stored.
   *
   * @param index - The live knowledge base.
   * @param aliases - The index to resolve against instead of the live one.
   * @param rows - The catalogue as stored.
   * @param productId - The bottling being edited, sorted to the front, or
   *   null when no single row is in focus.
   * @returns One entry per bottling whose producer, type or country would
   *   change.
   */
  private async runPass(
    index: KbIndex,
    aliases: KbAliasEntry[],
    rows: KbReconcileRow[],
    productId: ID | null,
  ): Promise<ReviewAffected[]> {
    const typeIds = await this.producers.resolveTypeIds(
      ReviewPreviewService.typeNames(index.aliases),
    );

    const plan = this.apply.plan(rows, { ...index, aliases }, typeIds);

    return this.diff(plan, rows, productId);
  }

  /**
   * What a pin reaches: the one bottling it is written on.
   *
   * @returns An empty impact, stated rather than computed.
   */
  private static pinPreview(): ReviewPreview {
    return {
      affected: [],
      affectedTotal: 0,
      reach: { frees: 1, steals: 0 },
    };
  }

  /**
   * Builds the index the action would produce.
   *
   * @param aliases - The live index.
   * @param added - The alias the action writes.
   * @param replacedKey - The key an existing alias is being widened from, so
   *   the old scope does not stay in the index beside the new one.
   * @returns The hypothetical index, longest key first — the order
   *   `matchInName` relies on to take the most specific match.
   */
  private static hypothetical(
    aliases: KbAliasEntry[],
    added: KbAliasEntry,
    replacedKey: string | null,
  ): KbAliasEntry[] {
    const kept = aliases.filter((alias) =>
      alias.key !== added.key || alias.producer.id !== added.producer.id
      || alias.key === replacedKey
    ).filter((alias) => alias.key !== replacedKey);

    return [...kept, added].sort((left, right) =>
      right.key.length - left.key.length || left.key.localeCompare(right.key)
    );
  }

  /**
   * The two numbers the binding block states.
   *
   * They are defined exactly because the owner asked what "changes producer"
   * means for a bottling that had none: **frees** counts bottlings that
   * resolve to nothing today and would resolve to something, **steals**
   * counts bottlings that resolve to a *different* producer today and would
   * be re-pointed. A bottling gaining its first producer belongs to the first
   * number only, never to the second.
   *
   * @param affected - The bottlings the action changes.
   * @param rows - The catalogue as stored.
   * @returns The two counts.
   */
  private static reachOf(
    affected: ReviewAffected[],
    rows: KbReconcileRow[],
  ): ReviewAliasScopeReach {
    const stored = new Map(rows.map((row) => [row.id, row]));

    let frees = 0;
    let steals = 0;

    affected.forEach((one) => {
      const row = stored.get(one.productId);

      if (!one.changes.producer) {
        return;
      }

      if (row && row.producerId === null && row.bottlerId === null) {
        frees += 1;

        return;
      }

      steals += 1;
    });

    return { frees, steals };
  }

  /**
   * The distinct whisky-type names the knowledge base states.
   *
   * @param aliases - The loaded alias index.
   * @returns Type names, without duplicates or blanks.
   */
  private static typeNames(aliases: KbAliasEntry[]): string[] {
    const names = new Set<string>();

    aliases.forEach((alias) => {
      const name = alias.producer.defaultTypeName;

      if (name) {
        names.add(name);
      }
    });

    return [...names];
  }

  /**
   * Diffs a hypothetical plan against what the catalogue holds.
   *
   * A `manual` producer link is skipped outright: `SET_PRODUCERS_SQL` would
   * not move it, so reporting it as reach would promise something the write
   * cannot do.
   *
   * @param plan - The plan the hypothetical index produced.
   * @param rows - The catalogue as stored.
   * @param productId - The bottling being edited, sorted to the front so the
   *   person sees their own row first.
   * @returns One entry per bottling whose producer, type or country would
   *   change.
   */
  private async diff(
    plan: KbApplyPlan,
    rows: KbReconcileRow[],
    productId: ID | null,
  ): Promise<ReviewAffected[]> {
    const stored = new Map(rows.map((row) => [row.id, row]));
    const facts = new Map(plan.facts.map((one) => [one.productId, one]));

    const changed = plan.producers
      .map((write) => {
        const row = stored.get(write.productId);

        if (!row || row.producerSource === FactSource.MANUAL) {
          return null;
        }

        const fact = facts.get(write.productId);
        const changes: ReviewAffectedChanges = {};

        if (row.producerId !== write.producerId) {
          changes.producer = { from: row.producerId, to: write.producerId };
        }

        if (fact?.countryId && fact.countryId !== row.countryId) {
          changes.country = { from: row.countryId, to: fact.countryId };
        }

        if (fact?.typeId && fact.typeId !== row.typeId) {
          changes.type = { from: row.typeId, to: fact.typeId };
        }

        if (!Object.keys(changes).length) {
          return null;
        }

        return {
          productId: row.id,
          name: row.name,
          volumeMl: row.volumeMl,
          age: row.age,
          stores: [] as string[],
          inQueue: true,
          reviewStatus: null as ProductReviewStatus | null,
          changes,
        };
      })
      .filter((one): one is ReviewAffected => one !== null);

    changed.sort((left, right) =>
      Number(right.productId === productId)
      - Number(left.productId === productId)
    );

    return this.label(changed);
  }

  /**
   * Turns the ids inside a diff into the names a person reads.
   *
   * @param affected - The diff, carrying ids in its `from`/`to` slots.
   * @returns The same list with producer, type and country names.
   */
  private async label(
    affected: ReviewAffected[],
  ): Promise<ReviewAffected[]> {
    const ids = new Set<ID>();

    affected.forEach((one) => {
      [one.changes.producer, one.changes.type, one.changes.country]
        .forEach((change) => {
          if (change?.from) {
            ids.add(change.from as ID);
          }

          if (change?.to) {
            ids.add(change.to as ID);
          }
        });
    });

    const names = await this.products.findLabelsByIds([...ids]);

    const rename = (
      change?: { from: string | null; to: string | null },
    ): { from: string | null; to: string | null } | undefined =>
      change
        ? {
          from: change.from ? names.get(change.from as ID) ?? null : null,
          to: change.to ? names.get(change.to as ID) ?? null : null,
        }
        : undefined;

    return affected.map((one) => ({
      ...one,
      changes: {
        ...(rename(one.changes.producer)
          ? { producer: rename(one.changes.producer) }
          : {}),
        ...(rename(one.changes.type)
          ? { type: rename(one.changes.type) }
          : {}),
        ...(rename(one.changes.country)
          ? { country: rename(one.changes.country) }
          : {}),
      },
    }));
  }

  /**
   * Works out which producer an action points at.
   *
   * @param link - The action.
   * @returns The producer's id.
   * @throws {BadRequestError} When the action names none.
   */
  private async resolveTargetProducer(
    link: ReviewProducerLink,
  ): Promise<ID> {
    if (link.producerId) {
      return link.producerId;
    }

    if (link.aliasId) {
      const owner = await this.producers.findAliasProducer(link.aliasId);

      if (owner) {
        return owner.producerId;
      }
    }

    throw new BadRequestError('The action names no producer');
  }

  /**
   * Works out which spelling an action writes.
   *
   * @param link - The action.
   * @returns The normalized key.
   * @throws {BadRequestError} When the spelling normalizes to nothing.
   */
  private async resolveSpelling(link: ReviewProducerLink): Promise<string> {
    const raw = link.spelling
      ?? (link.aliasId
        ? (await this.producers.findAliasProducer(link.aliasId))?.key
        : null);

    const key = KbKeyUtils.key(raw ?? '');

    if (!key) {
      throw new BadRequestError('The spelling matches nothing once normalized');
    }

    return key;
  }
}
