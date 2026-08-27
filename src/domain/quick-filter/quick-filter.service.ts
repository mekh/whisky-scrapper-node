import { Injectable } from '@nestjs/common';

import { CoreQuickFilterService } from '~core/quick-filter';
import { CoreUserService } from '~core/user';
import type {
  ID,
  QuickFilter,
  QuickFilterCreateInput,
  QuickFilterUpdateInput,
} from '~types';

/**
 * Business layer for saved filter sets. Thin by design — the payload is opaque
 * here, so there is nothing to validate beyond what the DTO already checked,
 * and the interesting rules (per-user cap, name uniqueness, ownership) are
 * transactional and live in {@link CoreQuickFilterService}.
 */
@Injectable()
export class QuickFilterService {
  public constructor(
    private readonly quickFilters: CoreQuickFilterService,
    private readonly users: CoreUserService,
  ) {}

  /**
   * Lists the calling user's own filter sets.
   *
   * No existence check: the id comes from a verified access token.
   *
   * @param userId - The authenticated user.
   * @returns Their sets, alphabetically.
   */
  public async getOwn(userId: ID): Promise<QuickFilter[]> {
    return this.quickFilters.findByUserId(userId);
  }

  /**
   * Lists another user's filter sets, for an admin or for the user themselves.
   *
   * @param userId - Whose sets to read.
   * @returns Their sets, alphabetically.
   * @throws {NotFoundError} When no such user exists — otherwise a mistyped id
   *   would answer with an empty but entirely plausible list.
   */
  public async getForUser(userId: ID): Promise<QuickFilter[]> {
    await this.users.findByIdOrThrow(userId);

    return this.quickFilters.findByUserId(userId);
  }

  /**
   * Saves a new filter set for the calling user.
   *
   * @param userId - The authenticated user.
   * @param input - The set's name and opaque payload.
   * @returns Their sets after the change.
   */
  public async create(
    userId: ID,
    input: QuickFilterCreateInput,
  ): Promise<QuickFilter[]> {
    return this.quickFilters.createForUser(userId, input);
  }

  /**
   * Renames one of the calling user's sets and/or replaces its filters.
   *
   * @param userId - The authenticated user.
   * @param id - The set to update.
   * @param input - The fields to change.
   * @returns Their sets after the change.
   */
  public async update(
    userId: ID,
    id: ID,
    input: QuickFilterUpdateInput,
  ): Promise<QuickFilter[]> {
    return this.quickFilters.updateForUser(userId, id, input);
  }

  /**
   * Deletes one of the calling user's sets.
   *
   * @param userId - The authenticated user.
   * @param id - The set to delete.
   * @returns Their sets after the change.
   */
  public async remove(userId: ID, id: ID): Promise<QuickFilter[]> {
    return this.quickFilters.deleteForUser(userId, id);
  }
}
