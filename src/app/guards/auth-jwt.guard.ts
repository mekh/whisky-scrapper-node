import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

import { AuthService } from '~domain/auth';
import { NotAuthenticatedError } from '~errors';

import { ClsService, ContextManager } from '../context';

@Injectable()
export class AuthJwtGuard implements CanActivate {
  public constructor(
    private readonly authService: AuthService,
    private readonly cls: ClsService,
  ) {}

  /**
   * Authenticates the request from its bearer access token. Populates both
   * the CLS store (read by `PermissionGuard`) and the request context (read
   * by the `@CurrentUser` decorator). For public resources a missing or
   * invalid token is tolerated.
   *
   * @param ctx - The Nest execution context for the request.
   * @returns `true` when the request may proceed.
   */
  public async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const context = ContextManager.create(ctx);

    if (context.user?.id) {
      return true;
    }

    return context.isResourcePublic()
      ? this.verify(context).catch(() => true)
      : this.verify(context);
  }

  /**
   * Verifies the access token and stores the resolved user on both the CLS
   * store and the request context.
   *
   * @param context - The request context manager for the current request.
   * @returns `true` once the user has been authenticated and stored.
   * @throws {NotAuthenticatedError} When no token is present or invalid.
   */
  private async verify(context: ContextManager): Promise<boolean> {
    const token = context.accessToken;

    if (!token) {
      throw new NotAuthenticatedError();
    }

    const user = await this.authService.authenticate(token);

    this.cls.user = user;
    context.user = user;

    return true;
  }
}
