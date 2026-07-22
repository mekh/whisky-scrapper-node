import { Action, PermissionMode, Resource } from '~enums';

import { CtxManager, CtxUser } from './ctx.interfaces';
import { EntityUser } from './entity.interfaces';
import { Permission } from './permission.interfaces';

/**
 * Resources scoped by an `Action` and matched against the user's granted
 * permissions. Excludes the special resources (`PUBLIC`, `AUTHENTICATED`,
 * `SELF`), which are never paired with an `Action`.
 */
export type ScopedResource = Exclude<
  Resource,
  Resource.PUBLIC | Resource.AUTHENTICATED | Resource.SELF
>;

/**
 * A single authorization requirement:
 *
 * - `[PUBLIC]` / `[AUTHENTICATED]` — special resources, no action.
 * - `[SELF, CanDo]` — `CanDo` is mandatory; a bare `[SELF]` is rejected and
 *   `SELF` is never paired with an `Action`.
 * - `[ScopedResource, Action]` (with optional `CanDo`) — the user must hold
 *   the matching scope, optionally narrowed by `CanDo`.
 */
export type AuthPermission =
  | [Resource.AUTHENTICATED]
  | [Resource.PUBLIC]
  | [Resource.SELF, CanDo]
  | [ScopedResource, Action]
  | [ScopedResource, Action, CanDo];

export type CanDo = (ctx: CtxManager) => boolean;
export type PermCheckCb = (perm: AuthPermission) => boolean;

export interface AuthPermissionMeta {
  permissions: AuthPermission[];
  isPublic: boolean;
  mode: PermissionMode;
  check: (cb: PermCheckCb) => boolean;
}

export interface AuthUser extends Pick<EntityUser, 'id' | 'admin'> {
  permissions: Permission[];
}

export interface AuthTokens {
  access: string;
  refresh: string;
}

export interface AuthLoginInput {
  login: string;
  password: string;
  ip: string;
  userAgent: string;
}

export type AuthCredentials = Pick<AuthLoginInput, 'login' | 'password'>;

export type AuthAccess = Pick<AuthTokens, 'access'>;

export type AuthMe = Pick<CtxUser, 'id' | 'sid' | 'admin'> & {
  /**
   * The user's own permissions as `resource:action` strings, for UI gating.
   */
  permissions: string[];
};
