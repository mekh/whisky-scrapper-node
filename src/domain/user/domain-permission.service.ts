import { Injectable } from '@nestjs/common';

import { CorePermissionService } from '~core/permissions';
import { CoreUserService } from '~core/user';
import { Action, Resource } from '~enums';

import { DomainBaseService } from '../_common';

import type {
  EntityPermission,
  ID,
  Permission,
  PermissionConfig,
  PermissionGroup,
  PermissionSet,
} from '~types';

/**
 * Business-layer permission operations behind the user-permissions
 * controller. Translates between the persisted flat rows and the grouped
 * `{ resource, actions[] }` shape used by the API, and exposes the static
 * resource/action catalogue.
 */
@Injectable()
export class DomainPermissionService extends DomainBaseService<
  EntityPermission
> {
  /**
   * Groups flat permission rows by resource into the API set shape.
   *
   * @param rows - The user's persisted permission rows.
   * @returns One group per resource, each listing its granted actions.
   */
  private static group(rows: EntityPermission[]): PermissionGroup[] {
    const map = rows.reduce(
      (acc, row) => {
        const actions = acc.get(row.resource) ?? [];

        actions.push(row.action);

        return acc.set(row.resource, actions);
      },
      new Map<Resource, Action[]>(),
    );

    return [...map.entries()].map(
      ([resource, actions]) => ({ resource, actions }),
    );
  }

  /**
   * Flattens grouped permissions into de-duplicated resource/action tuples.
   *
   * @param groups - The grouped permissions from a request body.
   * @returns The unique set of flat tuples to persist.
   */
  private static flatten(groups: PermissionGroup[]): Permission[] {
    const seen = new Set<string>();

    return groups.flatMap((group) =>
      group.actions
        .filter((action) => {
          const key = `${group.resource}:${action}`;

          if (seen.has(key)) {
            return false;
          }

          seen.add(key);

          return true;
        })
        .map((action) => ({ resource: group.resource, action }))
    );
  }

  public constructor(
    private readonly perms: CorePermissionService,
    private readonly users: CoreUserService,
  ) {
    super(perms);
  }

  /**
   * Returns every enum-backed resource and action the system supports.
   *
   * @returns The full resource/action catalogue.
   */
  public getConfig(): PermissionConfig {
    return {
      resources: Object.values(Resource),
      actions: Object.values(Action),
    };
  }

  /**
   * Loads a user's permissions in the grouped API shape.
   *
   * @param userId - Identifier of the user whose permissions are read.
   * @returns The user's permissions grouped by resource.
   * @throws {NotFoundError} When no user has the given id.
   */
  public async getForUser(userId: ID): Promise<PermissionSet> {
    await this.users.findByIdOrThrow(userId);

    const rows = await this.perms.getByUserId(userId);

    return { permissions: DomainPermissionService.group(rows) };
  }

  /**
   * Overwrites a user's permissions with exactly the supplied set, then
   * returns the persisted result in the grouped API shape.
   *
   * @param userId - Identifier of the user whose permissions are rewritten.
   * @param input - The desired permission set.
   * @returns The user's permissions after the replacement.
   * @throws {NotFoundError} When no user has the given id.
   */
  public async setForUser(
    userId: ID,
    input: PermissionSet,
  ): Promise<PermissionSet> {
    await this.users.findByIdOrThrow(userId);

    const tuples = DomainPermissionService.flatten(input.permissions);
    const rows = await this.perms.replaceForUser(userId, tuples);

    return { permissions: DomainPermissionService.group(rows) };
  }
}
