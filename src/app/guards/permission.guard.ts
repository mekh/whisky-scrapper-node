import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { Action, Resource } from '~enums';
import { AuthPermission, CanDo, CtxUser } from '~types';

import { ContextManager } from '../context';

@Injectable()
export class PermissionGuard implements CanActivate {
  /**
   * Authorizes the current request against the handler's permission
   * metadata, combining the declared permissions with their `AND`/`OR`
   * mode. Public resources short-circuit to allowed. The current user is
   * read from the request context (populated per-request by
   * {@link AuthJwtGuard}), never from shared state.
   *
   * @param executionContext - The Nest execution context for the request.
   * @returns `true` when the request satisfies the required permissions.
   */
  public async canActivate(
    executionContext: ExecutionContext,
  ): Promise<boolean> {
    const ctx = ContextManager.create(executionContext);

    if (ctx.isResourcePublic()) {
      return true;
    }

    const { check } = ctx.getMetaOrThrow();

    return check((permission: AuthPermission): boolean =>
      this.checkPermission(ctx, permission)
    );
  }

  /**
   * Evaluates a single permission tuple. The `Action` and optional
   * `CanDo` are located by type, so an action-less permission
   * (`[Resource]` or `[Resource, CanDo]`) is handled the same as the
   * `[Resource, Action]` / `[Resource, Action, CanDo]` forms.
   *
   * @param ctx - The request context manager, passed to any `CanDo`.
   * @param permission - The permission tuple to evaluate.
   * @returns `true` when this permission is satisfied.
   */
  private checkPermission(
    ctx: ContextManager,
    permission: AuthPermission,
  ): boolean {
    const [resource] = permission;
    const spec = permission.slice(1);

    const canDo = spec.find(
      (item): item is CanDo => typeof item === 'function',
    );

    const action = spec.find(
      (item): item is Action => typeof item !== 'function',
    );

    const canDoFn = canDo
      ? (): boolean => canDo(ctx.manager)
      : (): boolean => true;

    return this.canDo(ctx.user, resource, action, canDoFn);
  }

  /**
   * Resolves whether the current user may act on a resource. Admins and
   * `PUBLIC` pass unconditionally; `AUTHENTICATED` and `SELF` require a
   * logged-in user and defer to `canDo`; any other resource additionally
   * requires the matching scope (and `action`, when present).
   *
   * @param user - The current request user, or `null` when unauthenticated.
   * @param resource - The resource being accessed.
   * @param action - The action required, or `undefined` for action-less
   *   resources (`PUBLIC`/`AUTHENTICATED`/`SELF`).
   * @param canDo - Contextual predicate (e.g. an ownership/self check).
   * @returns `true` when access is granted.
   */
  private canDo(
    user: CtxUser | null,
    resource: Resource,
    action: Action | undefined,
    canDo: () => boolean,
  ): boolean {
    const isSelfLike = resource === Resource.AUTHENTICATED
      || resource === Resource.SELF;

    if (
      user?.admin
      || resource === Resource.PUBLIC
      || user && isSelfLike
    ) {
      return canDo();
    }

    if (!user) {
      return false;
    }

    const scope = user.permissions?.get(resource);
    const hasPermission = action ? scope?.has(action) : !!scope;

    return canDo() && !!hasPermission;
  }
}
