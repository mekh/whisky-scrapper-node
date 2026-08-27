import { Injectable } from '@nestjs/common';
import { Transactional } from 'typeorm-transactional';

import {
  QUICK_FILTER_MAX_PER_USER,
  QUICK_FILTER_NAME_MAX_LENGTH,
} from '~constants';
import { CoreBaseService } from '~core/_common';
import { BadRequestError, DuplicateError, NotFoundError } from '~errors';
import type {
  ID,
  QuickFilter,
  QuickFilterCreateInput,
  QuickFilterUpdateInput,
} from '~types';

import { QuickFilterEntity } from './quick-filter.entity';
import { QuickFilterRepository } from './quick-filter.repository';

/**
 * Postgres' unique-violation SQLSTATE, raised by the
 * `quick_filter_user_name_uindex` index.
 */
const UNIQUE_VIOLATION = '23505';

/**
 * Persistence-layer public API for saved filter sets.
 *
 * `uniqueFields` is deliberately left empty: {@link CoreBaseService} enforces
 * it *globally*, while a set's name is unique only within one user. Uniqueness
 * is owned here instead — a case-insensitive pre-check for the message the
 * client shows, and the unique index for the race.
 *
 * Every write returns the user's whole list, which is what lets a client
 * replace its cached copy from the response with no follow-up read.
 */
@Injectable()
export class CoreQuickFilterService extends CoreBaseService<QuickFilterEntity> {
  /**
   * Collapses a name to its stored form: outer whitespace trimmed, internal
   * runs collapsed to one space. Applied before both the duplicate check and
   * the write, so «Айла  торф» and «Айла торф» cannot both exist.
   *
   * @param name - The raw name from the request.
   * @returns The normalized name.
   * @throws {BadRequestError} When nothing but whitespace was given, or the
   *   normalized name is still too long.
   */
  private static normalizeName(name: string): string {
    const normalized = name.trim().replace(/\s+/g, ' ');

    if (!normalized.length) {
      throw new BadRequestError('Quick filter name must not be empty');
    }

    if (normalized.length > QUICK_FILTER_NAME_MAX_LENGTH) {
      throw new BadRequestError(
        `Quick filter name must be at most ${QUICK_FILTER_NAME_MAX_LENGTH} `
          + 'characters',
      );
    }

    return normalized;
  }

  /**
   * Reports whether a caught error is the name index rejecting a duplicate.
   *
   * The pre-check below cannot be atomic on its own, so two tabs saving the
   * same name concurrently reach the index — which must answer 409 like the
   * check does, not 500.
   *
   * @param error - The error thrown by the write.
   * @returns True when it is a unique-constraint violation.
   */
  private static isUniqueViolation(error: unknown): boolean {
    const driverError = (error as { driverError?: { code?: string } })
      ?.driverError;

    return driverError?.code === UNIQUE_VIOLATION;
  }

  public constructor(protected readonly repo: QuickFilterRepository) {
    super(repo);
  }

  /**
   * Lists a user's filter sets, alphabetically.
   *
   * @param userId - Whose sets to list.
   * @returns The sets; empty when the user saved none.
   */
  public async findByUserId(userId: ID): Promise<QuickFilter[]> {
    return this.repo.findByUserId(userId);
  }

  /**
   * Saves a new filter set for a user.
   *
   * The cap and the duplicate check run inside the transaction with the insert
   * so two concurrent saves cannot both pass them.
   *
   * @param userId - The owner.
   * @param input - The set's name and opaque payload.
   * @returns The user's sets after the change.
   * @throws {BadRequestError} When the user already holds the maximum number
   *   of sets, or the name is blank.
   * @throws {DuplicateError} When the user already has a set with that name,
   *   ignoring case.
   */
  @Transactional()
  public async createForUser(
    userId: ID,
    input: QuickFilterCreateInput,
  ): Promise<QuickFilter[]> {
    const name = CoreQuickFilterService.normalizeName(input.name);
    const count = await this.repo.countByUserId(userId);

    if (count >= QUICK_FILTER_MAX_PER_USER) {
      throw new BadRequestError(
        `You can save at most ${QUICK_FILTER_MAX_PER_USER} quick filters`,
      );
    }

    await this.assertNameFree(userId, name);

    await this.write(
      () => this.repo.insertForUser(userId, { name, filters: input.filters }),
      name,
    );

    return this.repo.findByUserId(userId);
  }

  /**
   * Renames a set and/or replaces its filters.
   *
   * An absent field is genuinely absent (`exposeUnsetFields: false`), so a
   * rename never touches the stored payload — which is what keeps a client
   * that cannot parse a newer filter dimension from destroying it.
   *
   * @param userId - The owner.
   * @param id - The set to update.
   * @param input - The fields to change.
   * @returns The user's sets after the change.
   * @throws {NotFoundError} When the id is unknown or belongs to another user.
   * @throws {DuplicateError} When the new name collides, ignoring case.
   */
  @Transactional()
  public async updateForUser(
    userId: ID,
    id: ID,
    input: QuickFilterUpdateInput,
  ): Promise<QuickFilter[]> {
    const name = input.name === undefined
      ? undefined
      : CoreQuickFilterService.normalizeName(input.name);

    if (name !== undefined) {
      await this.assertNameFree(userId, name, id);
    }

    const patch: QuickFilterUpdateInput = {
      ...name === undefined ? {} : { name },
      ...input.filters === undefined ? {} : { filters: input.filters },
    };

    const updated = await this.write(
      () => this.repo.updateForUser(id, userId, patch),
      name ?? '',
    );

    if (!updated) {
      throw new NotFoundError('Quick filter not found');
    }

    return this.repo.findByUserId(userId);
  }

  /**
   * Deletes one of a user's sets.
   *
   * @param userId - The owner.
   * @param id - The set to delete.
   * @returns The user's sets after the change.
   * @throws {NotFoundError} When the id is unknown or belongs to another user.
   */
  @Transactional()
  public async deleteForUser(userId: ID, id: ID): Promise<QuickFilter[]> {
    const deleted = await this.repo.deleteForUser(id, userId);

    if (!deleted) {
      throw new NotFoundError('Quick filter not found');
    }

    return this.repo.findByUserId(userId);
  }

  /**
   * Rejects a name the user already uses, ignoring case.
   *
   * @param userId - Whose sets to check.
   * @param name - The normalized candidate name.
   * @param exceptId - A set allowed to hold the name (itself, when renaming).
   * @throws {DuplicateError} When another set of this user holds the name.
   */
  private async assertNameFree(
    userId: ID,
    name: string,
    exceptId?: ID,
  ): Promise<void> {
    const existing = await this.repo.findByUserAndNameCi(userId, name);

    if (existing && existing.id !== exceptId) {
      throw new DuplicateError(
        `Quick filter "${existing.name}" already exists`,
      );
    }
  }

  /**
   * Runs a write, translating the unique index's rejection into the same error
   * the pre-check raises.
   *
   * @param write - The insert or update to run.
   * @param name - The name being written, for the error message.
   * @returns Whatever the write returned.
   * @throws {DuplicateError} When the name index rejected the write.
   */
  private async write<T>(write: () => Promise<T>, name: string): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (CoreQuickFilterService.isUniqueViolation(error)) {
        throw new DuplicateError(`Quick filter "${name}" already exists`);
      }

      throw error;
    }
  }
}
