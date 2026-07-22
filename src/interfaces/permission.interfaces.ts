import { Action, Resource } from '~enums';

import { EntityPermission } from './entity.interfaces';

/**
 * A single, flat permission tuple: one action on one resource. Mirrors the
 * persisted row shape without the entity's identity/audit columns.
 */
export type Permission = Pick<EntityPermission, 'resource' | 'action'>;

export type PermissionMap = Map<Resource, Set<Action>>;

export interface PermissionGroup {
  /**
   * The resource the actions apply to. One group per resource.
   */
  resource: Resource;

  /**
   * The actions granted on {@link PermissionGroup.resource}. Duplicates are
   * collapsed; order is not significant.
   */
  actions: Action[];
}

export interface PermissionSet {
  /**
   * The full set of a user's permissions, grouped by resource. This is the
   * shape exchanged by the user-permissions endpoints (both directions).
   */
  permissions: PermissionGroup[];
}

export interface PermissionConfig {
  /**
   * Every resource the system knows about. Sourced from the `Resource` enum.
   */
  resources: Resource[];

  /**
   * Every action the system knows about. Sourced from the `Action` enum.
   */
  actions: Action[];
}
