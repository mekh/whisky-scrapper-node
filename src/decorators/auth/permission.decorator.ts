import { SetMetadata, applyDecorators } from '@nestjs/common';

import { PERMISSION_META_INJECT_TOKEN } from '~constants';
import { PermissionMode, Resource } from '~enums';
import { ServerError } from '~errors';
import { AuthPermission, AuthPermissionMeta, PermCheckCb } from '~types';

export function Permission(...permission: AuthPermission): MethodDecorator;
export function Permission(AND: AuthPermission[]): MethodDecorator;
export function Permission(...OR: AuthPermission[]): MethodDecorator;

/**
 * Attaches permission metadata to a route handler for `PermissionGuard`.
 *
 * A single permission is passed positionally, mirroring an
 * `AuthPermission` tuple: a lone `Resource` (`PUBLIC`/`AUTHENTICATED`),
 * `Resource` + `CanDo` (`SELF`), `Resource` + `Action`, or
 * `Resource` + `Action` + `CanDo`. Several permissions are passed either
 * as one array (combined with `AND`) or spread as separate arguments
 * (combined with `OR`).
 *
 * @param arg - A `Resource`, a single permission tuple, or an array of
 *   permission tuples (the `AND` form).
 * @param rest - The rest of a positional permission (`Action`/`CanDo`),
 *   or further permission tuples (the `OR` form).
 * @returns A method decorator storing the derived `AuthPermissionMeta`.
 * @throws {ServerError} If no permission can be derived from the input.
 */
export function Permission(
  arg: unknown,
  ...rest: unknown[]
): MethodDecorator {
  if (!arg) {
    throw new ServerError('Invalid permissions');
  }

  let perms: Omit<AuthPermissionMeta, 'isPublic' | 'check'>;

  if (!Array.isArray(arg)) {
    // Positional single permission: (R), (R, A),
    // (R, CanDo) or (R, A, CanDo).
    perms = {
      permissions: [[arg, ...rest] as AuthPermission],
      mode: PermissionMode.AND,
    };
  } else if (rest.length) {
    // OR spread: ([R, A], [R, A], ...).
    perms = {
      permissions: [arg, ...rest] as AuthPermission[],
      mode: PermissionMode.OR,
    };
  } else if (Array.isArray(arg[0])) {
    // AND list: ([[R, A], [R, A]]).
    perms = {
      permissions: arg as AuthPermission[],
      mode: PermissionMode.AND,
    };
  } else {
    // Single permission tuple: ([R, A]).
    perms = {
      permissions: [arg] as AuthPermission[],
      mode: PermissionMode.AND,
    };
  }

  let isPublic = perms.mode === PermissionMode.AND;

  perms.permissions.forEach(([res]) => {
    isPublic = perms.mode === PermissionMode.OR
      ? isPublic || res === Resource.PUBLIC
      : isPublic && res === Resource.PUBLIC;
  });

  const check = (cb: PermCheckCb): boolean =>
    perms.mode === PermissionMode.AND
      ? perms.permissions.every((p) => cb(p))
      : perms.permissions.some((p) => cb(p));

  const meta: AuthPermissionMeta = { ...perms, isPublic, check };

  return applyDecorators(
    SetMetadata(PERMISSION_META_INJECT_TOKEN, meta),
  );
}
