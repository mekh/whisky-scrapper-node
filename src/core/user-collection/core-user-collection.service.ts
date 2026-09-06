import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import { DuplicateError, NotFoundError } from '~errors';
import type { CollectionRow, CollectionRowResolved, ID } from '~types';

import { UserCollectionEntity } from './user-collection.entity';
import { UserCollectionRepository } from './user-collection.repository';

/**
 * Postgres' unique-violation SQLSTATE, raised by the
 * `user_collection_user_product_uindex` index.
 */
const UNIQUE_VIOLATION = '23505';

/**
 * Persistence-layer public API for the personal collection.
 *
 * `uniqueFields` is deliberately left at {@link CoreBaseService}'s empty
 * default: that check enforces uniqueness *globally*, while the same
 * bottling may legitimately sit in many different users' collections.
 * Uniqueness here is owned by the `user_collection_user_product_uindex`
 * index instead — the same reasoning `CoreQuickFilterService` documents for
 * its own per-user name index.
 */
@Injectable()
export class CoreUserCollectionService
  extends CoreBaseService<UserCollectionEntity> {
  /**
   * Reports whether a caught error is the `(userId, productId)` index
   * rejecting a duplicate.
   *
   * @param error - The error thrown by the write.
   * @returns True when it is a unique-constraint violation.
   */
  private static isUniqueViolation(error: unknown): boolean {
    const driverError = (error as { driverError?: { code?: string } })
      ?.driverError;

    return driverError?.code === UNIQUE_VIOLATION;
  }

  public constructor(protected readonly repo: UserCollectionRepository) {
    super(repo);
  }

  /**
   * Lists a user's collection, newest first.
   *
   * @param userId - Whose collection to list.
   * @returns The rows; empty when the user has added nothing yet.
   */
  public async findByUserId(userId: ID): Promise<CollectionRow[]> {
    return this.repo.findByUserId(userId);
  }

  /**
   * Loads one collection row belonging to a user.
   *
   * @param id - The row to load.
   * @param userId - Its claimed owner; a mismatch matches no row.
   * @returns The row, or null when the pair matches none.
   */
  public async findByIdForUser(
    id: ID,
    userId: ID,
  ): Promise<CollectionRow | null> {
    return this.repo.findByIdForUser(id, userId);
  }

  /**
   * Loads a user's collection row for one bottling, when they hold it.
   *
   * @param productId - The bottling to look up.
   * @param userId - Whose collection to search.
   * @returns The row, or null when the user does not hold this bottling.
   */
  public async findByProductForUser(
    productId: ID,
    userId: ID,
  ): Promise<CollectionRow | null> {
    return this.repo.findByProductForUser(productId, userId);
  }

  /**
   * Lists the bottlings a user already holds, for a catalogue's "already in
   * collection" mark.
   *
   * @param userId - Whose collection to read.
   * @returns The bottling ids; empty when the user holds none.
   */
  public async findProductIdsByUserId(userId: ID): Promise<ID[]> {
    return this.repo.findProductIdsByUserId(userId);
  }

  /**
   * Confirms a collection row belongs to a user, for a caller that only
   * needs to prove ownership before touching a child purchase.
   *
   * @param id - The collection row to check.
   * @param userId - Its claimed owner.
   * @returns The row's own id.
   * @throws {NotFoundError} When the pair matches no row.
   */
  public async findIdForUserOrThrow(id: ID, userId: ID): Promise<ID> {
    const found = await this.repo.findIdForUser(id, userId);

    if (!found) {
      throw new NotFoundError('Collection item not found', { id });
    }

    return found;
  }

  /**
   * Adds a bottling to a user's collection.
   *
   * @param userId - The owner.
   * @param productId - The bottling to add.
   * @param values - The row's own fields (rating, notes, ...).
   * @returns The new collection row's id.
   * @throws {DuplicateError} When the bottling is already in the collection.
   */
  public async createForUser(
    userId: ID,
    productId: ID,
    values: CollectionRowResolved,
  ): Promise<ID> {
    try {
      return await this.repo.insertForUser(userId, productId, values);
    } catch (error) {
      if (CoreUserCollectionService.isUniqueViolation(error)) {
        throw new DuplicateError(
          'Product is already in the collection',
          { productId },
        );
      }

      throw error;
    }
  }

  /**
   * Applies a patch to one of a user's collection rows.
   *
   * @param userId - The owner.
   * @param id - The row to update.
   * @param values - The fields to change; an absent field is left alone.
   * @throws {NotFoundError} When the id is unknown or belongs to another
   *   user.
   */
  public async updateForUser(
    userId: ID,
    id: ID,
    values: CollectionRowResolved,
  ): Promise<void> {
    const updated = await this.repo.updateForUser(id, userId, values);

    if (!updated) {
      throw new NotFoundError('Collection item not found', { id });
    }
  }

  /**
   * Removes one of a user's collection rows.
   *
   * @param userId - The owner.
   * @param id - The row to delete.
   * @throws {NotFoundError} When the id is unknown or belongs to another
   *   user.
   */
  public async deleteForUser(userId: ID, id: ID): Promise<void> {
    const deleted = await this.repo.deleteForUser(id, userId);

    if (!deleted) {
      throw new NotFoundError('Collection item not found', { id });
    }
  }
}
