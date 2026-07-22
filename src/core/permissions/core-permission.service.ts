import { Injectable } from '@nestjs/common';
import { QueryDeepPartialEntity } from 'typeorm';
import { Transactional } from 'typeorm-transactional';

import { CoreBaseService } from '~core/_common';

import { PermissionEntity } from './permission.entity';
import { PermissionRepository } from './permission.repository';

import type { ID, Permission } from '~types';

/**
 * Persistence-layer public API for the `scope` (permission) entity. Inherits
 * the generic CRUD surface from {@link CoreBaseService} and adds the
 * per-user, set-oriented operations the permission endpoints rely on.
 */
@Injectable()
export class CorePermissionService extends CoreBaseService<PermissionEntity> {
  /**
   * Builds the stable de-duplication key for a permission tuple.
   *
   * @param input - The resource/action pair to encode.
   * @returns A `resource:action` string uniquely identifying the tuple.
   */
  private static toKey(input: Permission): string {
    return `${input.resource}:${input.action}`;
  }

  protected readonly uniqueFields: ('userId' | 'resource' | 'action')[] = [];

  public constructor(protected readonly repo: PermissionRepository) {
    super(repo);
  }

  /**
   * Lists all permissions granted to a single user.
   *
   * @param userId - Identifier of the owning user.
   * @returns The user's permission rows.
   */
  public async getByUserId(userId: ID): Promise<PermissionEntity[]> {
    return this.repo.findByUserId(userId);
  }

  /**
   * Replaces a user's permission set with exactly the supplied tuples: rows
   * absent from `input` are deleted, tuples missing from the database are
   * inserted, and unchanged tuples are left untouched. Runs in a single
   * transaction.
   *
   * @param userId - Identifier of the user whose permissions are rewritten.
   * @param input - The desired, de-duplicated set of resource/action tuples.
   * @returns The user's permissions after the replacement.
   */
  @Transactional()
  public async replaceForUser(
    userId: ID,
    input: Permission[],
  ): Promise<PermissionEntity[]> {
    const repo = this.repo as PermissionRepository;
    const existing = await repo.findByUserId(userId);

    const desired = new Set(
      input.map((tuple) => CorePermissionService.toKey(tuple)),
    );

    const current = new Set(
      existing.map((row) => CorePermissionService.toKey(row)),
    );

    const toDelete = existing.filter(
      (row) => !desired.has(CorePermissionService.toKey(row)),
    );

    const toCreate = input.filter(
      (tuple) => !current.has(CorePermissionService.toKey(tuple)),
    );

    if (toDelete.length) {
      await repo.delete(toDelete.map((row) => row.id));
    }

    if (toCreate.length) {
      const rows = toCreate.map((tuple) => ({
        userId,
        resource: tuple.resource,
        action: tuple.action,
      }));

      await repo.insert(rows as QueryDeepPartialEntity<PermissionEntity>[]);
    }

    return repo.findByUserId(userId);
  }
}
