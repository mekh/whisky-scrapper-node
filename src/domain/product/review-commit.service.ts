import { Injectable } from '@nestjs/common';
import { Transactional } from 'typeorm-transactional';

import { CACHE_GENERATION_CATALOGUE, REVIEW_PAGE_SIZE } from '~constants';
import { CoreProducerService } from '~core/producer';
import { CoreProductService } from '~core/product';
import {
  ProducerAliasScope,
  ProducerKind,
  ProductFactField,
  ProductReviewStatus,
  ReviewQueueStatus,
} from '~enums';
import { BadRequestError, DuplicateError, NotFoundError } from '~errors';
import { VersionedCacheService } from '~lib/cache';
import type {
  ID,
  ReviewBulkInput,
  ReviewBulkResult,
  ReviewCommitInput,
  ReviewCommitResult,
  ReviewMergeInput,
  ReviewPreview,
  ReviewProducerLink,
} from '~types';
import { KbKeyUtils } from '~utils';

import { KbReconcileService } from '~scrape/kb';

import { ProductService } from './product.service';
import { ReviewPreviewService } from './review-preview.service';

/**
 * The fact fields a reviewer may confirm without changing, mapped to the
 * provenance column each stamps. A closed vocabulary because the value
 * reaches a column name.
 */
const CONFIRMABLE: Readonly<Record<string, ProductFactField>> = {
  type: ProductFactField.TYPE,
  country: ProductFactField.COUNTRY,
  abv: ProductFactField.ABV,
  volume: ProductFactField.VOLUME,
  age: ProductFactField.AGE,
  name: ProductFactField.NAME,
};

/**
 * Which slice of the queue a bottling lands in once a verdict is written, so
 * a commit can read its own row back through the detectors it was judged by.
 */
const VERDICT_SLICE: Readonly<Record<ProductReviewStatus, ReviewQueueStatus>> =
  {
    [ProductReviewStatus.VERIFIED]: ReviewQueueStatus.VERIFIED,
    [ProductReviewStatus.REJECTED]: ReviewQueueStatus.REJECTED,
    [ProductReviewStatus.PENDING]: ReviewQueueStatus.OPEN,
  };

/**
 * Every write the curation screen makes.
 *
 * One request records everything a person decided about one bottling and
 * stamps the verdict, because a decision taken in five requests is a decision
 * that can half-happen. After it, the bottling never comes back to the queue
 * on its own: facts the person wrote are `manual` so no sync or knowledge-base
 * pass can move them, and the verdict itself excludes the row whatever the
 * detectors say.
 *
 * **Nothing automatic re-opens a verified bottling** — the owner's decision.
 * The only way back is a person pressing "Повернути в чергу".
 */
@Injectable()
export class ReviewCommitService {
  private readonly products: CoreProductService;

  private readonly producers: CoreProducerService;

  private readonly productService: ProductService;

  private readonly preview: ReviewPreviewService;

  private readonly reconcile: KbReconcileService;

  private readonly cache: VersionedCacheService;

  public constructor(
    products: CoreProductService,
    producers: CoreProducerService,
    productService: ProductService,
    preview: ReviewPreviewService,
    reconcile: KbReconcileService,
    cache: VersionedCacheService,
  ) {
    this.products = products;
    this.producers = producers;
    this.productService = productService;
    this.preview = preview;
    this.reconcile = reconcile;
    this.cache = cache;
  }

  /**
   * Records everything a person decided about one bottling.
   *
   * The order is load-bearing. The reach is measured **before** the write, so
   * the toast can repeat exactly what the person agreed to; the facts are
   * written next, because the merge they can trigger decides which row the
   * verdict lands on; the verdict goes on the survivor; and the
   * knowledge-base pass runs **after** the transaction, since an alias
   * changes what the whole catalogue resolves to and nothing inside one
   * bottling's transaction should carry that.
   *
   * @param input - The verdict and whatever the person changed.
   * @returns Where the decision landed, what it still leaves open, and the
   *   other bottlings it moved.
   * @throws {NotFoundError} When nothing has that id.
   * @throws {BadRequestError} When a value names something unknown.
   */
  public async commit(input: ReviewCommitInput): Promise<ReviewCommitResult> {
    const impact = input.producer
      ? await this.preview.previewLink(input.productId, input.producer)
      : ReviewCommitService.noImpact();

    const written = await this.write(input);

    if (input.producer && input.producer.mode !== 'pin') {
      await this.reconcile.run();
    }

    const issuesLeft = await this.issuesOf(written.productId, input.verdict);

    return {
      ...written,
      issuesLeft,
      affected: impact.affected,
      affectedTotal: impact.affectedTotal,
    };
  }

  /**
   * Folds one bottling into another, explicitly.
   *
   * The tool for a duplicate with many offers, where `relink` — which moves
   * one listing — is the wrong instrument. The vanishing row's key is retired
   * into `product_match_alias`, so the next sync cannot recreate it.
   *
   * @param input - Which row vanishes and which survives.
   * @returns The survivor's id.
   * @throws {BadRequestError} When the two are the same row.
   * @throws {NotFoundError} When either id names no bottling.
   */
  @Transactional()
  public async merge(input: ReviewMergeInput): Promise<ReviewCommitResult> {
    if (input.sourceId === input.targetId) {
      throw new BadRequestError('A bottling cannot be merged into itself');
    }

    const existing = await this.products.findExistingIds([
      input.sourceId,
      input.targetId,
    ]);

    if (existing.size !== 2) {
      throw new NotFoundError('Product not found');
    }

    await this.products.mergeInto(input.sourceId, input.targetId);

    this.cache.bumpAfterCommit(CACHE_GENERATION_CATALOGUE, 'review:merge');

    return {
      productId: input.targetId,
      merged: true,
      created: false,
      issuesLeft: [],
      affected: [],
      affectedTotal: 0,
    };
  }

  /**
   * Writes one fact across a selection, every value stamped `manual`.
   *
   * The `S.EDWARDS` and `Hyde` cases: a page of rows that all want the same
   * answer. One transaction, so the selection is written whole or not at all.
   *
   * @param input - The bottlings and the one fact to write.
   * @returns How many rows were written.
   * @throws {BadRequestError} When the request names no fact, or an unknown
   *   type, country or producer.
   */
  @Transactional()
  public async bulk(input: ReviewBulkInput): Promise<ReviewBulkResult> {
    const stated = [input.typeName, input.countryCode, input.producerId]
      .filter((one) => one !== undefined);

    if (stated.length !== 1) {
      throw new BadRequestError('A bulk write states exactly one fact');
    }

    const updated = await this.applyBulk(input);

    this.cache.bumpAfterCommit(CACHE_GENERATION_CATALOGUE, 'review:bulk');

    return { updated };
  }

  /**
   * An impact nobody has to be shown, for a commit that touches one row.
   *
   * @returns An empty impact.
   */
  private static noImpact(): ReviewPreview {
    return {
      affected: [],
      affectedTotal: 0,
      reach: { frees: 0, steals: 0 },
    };
  }

  /**
   * Everything one commit writes, in one transaction.
   *
   * @param input - The commit.
   * @returns Where the decision landed and whether a merge moved it.
   * @throws {NotFoundError} When nothing has that id.
   */
  @Transactional()
  private async write(
    input: ReviewCommitInput,
  ): Promise<Pick<ReviewCommitResult, 'productId' | 'merged' | 'created'>> {
    let productId = input.productId;
    let merged = false;

    if (input.patch) {
      const result = await this.productService.update({
        id: input.productId,
        ...input.patch,
      });

      productId = result.productId;
      merged = result.merged;
    }

    await this.confirm(productId, input.confirm ?? []);

    const created = input.producer
      ? await this.link(productId, input.producer)
      : false;

    await this.products.acknowledgeConflicts(productId);
    await this.products.applyReviewStatus([productId], input.verdict);

    this.cache.bumpAfterCommit(CACHE_GENERATION_CATALOGUE, 'review:commit');

    return { productId, merged, created };
  }

  /**
   * Stamps the facts a person confirmed without changing.
   *
   * @param productId - The bottling.
   * @param fields - The fields to stamp.
   * @throws {BadRequestError} When a name is not a fact field.
   */
  private async confirm(productId: ID, fields: string[]): Promise<void> {
    if (!fields.length) {
      return;
    }

    const mapped = fields.map((field) => {
      const column = CONFIRMABLE[field];

      if (!column) {
        throw new BadRequestError(`Unknown fact field: ${field}`);
      }

      return column;
    });

    await this.products.stampManual(productId, mapped);
  }

  /**
   * Makes the producer link the person chose.
   *
   * Three shapes, and they reach different numbers of bottlings on purpose: a
   * pin writes this bottling alone, an alias writes a spelling every bottling
   * carrying it resolves through, and widening changes what an existing
   * spelling already reaches.
   *
   * @param productId - The bottling.
   * @param link - The chosen way of linking.
   * @returns Whether a new alias row was created.
   * @throws {BadRequestError} When the link names nothing usable.
   * @throws {DuplicateError} When another producer already claims the
   *   spelling.
   */
  private async link(
    productId: ID,
    link: ReviewProducerLink,
  ): Promise<boolean> {
    if (link.mode === 'pin') {
      if (link.producerId) {
        await this.assertProducerSlot(link.producerId);
      }

      await this.products.setProducerManual(
        productId,
        link.producerId ?? null,
        link.bottlerId ?? null,
      );

      return false;
    }

    if (link.mode === 'widen-alias') {
      return this.widen(link);
    }

    if (!link.producerId || !link.spelling) {
      throw new BadRequestError('An alias needs a producer and a spelling');
    }

    const key = KbKeyUtils.key(link.spelling);

    if (!key) {
      throw new BadRequestError('The spelling matches nothing once normalized');
    }

    const written = await this.producers.addAlias(
      key,
      link.producerId,
      (link.scope as ProducerAliasScope | undefined)
        ?? ProducerAliasScope.LEAD,
      null,
    );

    if (!written) {
      await this.assertAliasIsOurs(key, link.producerId);
    }

    return written;
  }

  /**
   * Refuses a bottler in the producer slot, which the resolver refuses too —
   * the facts would then be read off a company that owns no still.
   *
   * @param producerId - The producer a manual link names.
   * @throws {BadRequestError} When nothing has that id, or it is a bottler.
   */
  private async assertProducerSlot(producerId: ID): Promise<void> {
    const kind = await this.producers.findKind(producerId);

    if (!kind) {
      throw new BadRequestError('Producer not found');
    }

    if (kind === ProducerKind.BOTTLER) {
      throw new BadRequestError(
        'A bottler cannot be the producer: record it as the owner of the'
          + ' range instead',
      );
    }
  }

  /**
   * Widens an existing spelling.
   *
   * @param link - The action, naming the alias and the new scope.
   * @returns False — widening writes no new row.
   * @throws {BadRequestError} When the alias or the scope is missing.
   * @throws {NotFoundError} When nothing has that alias id.
   */
  private async widen(link: ReviewProducerLink): Promise<boolean> {
    if (!link.aliasId || !link.scope) {
      throw new BadRequestError('Widening needs an alias and a scope');
    }

    const owner = await this.producers.findAliasProducer(link.aliasId);

    if (!owner) {
      throw new NotFoundError('Alias not found');
    }

    await this.producers.setAliasScope(
      link.aliasId,
      owner.producerId,
      link.scope,
    );

    return false;
  }

  /**
   * Turns a refused alias write into the right answer: silence when this
   * producer already had the spelling, a conflict when another one holds it.
   *
   * @param key - The normalized alias key.
   * @param producerId - The producer the caller aimed at.
   * @throws {DuplicateError} When another producer claims the key.
   */
  private async assertAliasIsOurs(
    key: string,
    producerId: ID,
  ): Promise<void> {
    const owner = await this.producers.findAliasOwner(key);

    if (owner && owner.producerId !== producerId) {
      throw new DuplicateError(`"${key}" already resolves to ${owner.name}`);
    }
  }

  /**
   * Writes the one fact a bulk request states.
   *
   * @param input - The bulk request.
   * @returns How many rows were written.
   * @throws {BadRequestError} When the value names something unknown.
   */
  private async applyBulk(input: ReviewBulkInput): Promise<number> {
    if (input.producerId !== undefined) {
      await this.assertProducerSlot(input.producerId);

      const written = await Promise.all(
        input.productIds.map((id) =>
          this.products.setProducerManual(id, input.producerId ?? null, null)
        ),
      );

      return written.filter((one) => one > 0).length;
    }

    const results = await Promise.all(
      input.productIds.map((id) =>
        this.productService.update({
          id,
          ...(input.typeName === undefined ? {} : { typeName: input.typeName }),
          ...(input.countryCode === undefined
            ? {}
            : { countryCode: input.countryCode }),
        })
      ),
    );

    return results.length;
  }

  /**
   * Reads back which detectors still fire on the bottling a commit landed on.
   *
   * Through the same query the queue uses, so "what is left" is the
   * detectors' own answer rather than a second opinion that could drift from
   * it.
   *
   * The slice is taken from the verdict rather than left at its default: the
   * open slice excludes a row somebody has just decided about, so asking for
   * it would always answer "nothing left" and say nothing at all.
   *
   * @param productId - The bottling.
   * @param verdict - The verdict just written, which decides the slice.
   * @returns The codes still firing, empty when the row is clean.
   */
  private async issuesOf(
    productId: ID,
    verdict: ProductReviewStatus,
  ): Promise<string[]> {
    const { rows } = await this.products.findReviewQueue(
      {
        productIds: [productId],
        includeUnstocked: true,
        includeAcknowledged: true,
        status: VERDICT_SLICE[verdict],
        perPage: REVIEW_PAGE_SIZE,
      },
      { rejected: [], withheld: [] },
    );

    return rows[0]?.issues.map((issue) => issue.code) ?? [];
  }
}
