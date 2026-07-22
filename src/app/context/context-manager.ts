import { ContextType, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { PERMISSION_META_INJECT_TOKEN } from '~constants';
import { ServerError } from '~errors';

import { HttpContextManager } from './http-context-manager';

import { AuthPermissionMeta, CtxManager, CtxUser } from '~types';

export class ContextManager {
  public static create(ctx: ExecutionContext): ContextManager {
    return new ContextManager(ctx);
  }

  private readonly reflector: Reflector;

  private readonly type: ContextType;

  constructor(private readonly ctx: ExecutionContext) {
    this.type = ctx.getType();
    this.reflector = new Reflector();
  }

  public get user(): CtxUser | null {
    return this.manager.user ?? null;
  }

  public set user(user: CtxUser | null) {
    this.manager.user = user;
  }

  public get accessToken(): string | undefined {
    return this.manager.getAccessToken();
  }

  public get refreshToken(): string | undefined {
    return this.manager.getRefreshToken();
  }

  public get sessionId(): string | undefined {
    return this.manager.sessionId;
  }

  public set sessionId(sessionId: string | undefined) {
    this.manager.sessionId = sessionId;
  }

  public get manager(): CtxManager {
    let ctx: CtxManager;

    switch (this.type) {
      case 'http':
        ctx = HttpContextManager.create(this.ctx);
        break;
      default:
        throw new ServerError(`unknown context ${this.ctx.getType()}`);
    }

    return ctx;
  }

  public getMetaOrThrow(): AuthPermissionMeta {
    const handler = this.ctx.getHandler();

    const meta = this.reflector.get<AuthPermissionMeta | undefined>(
      PERMISSION_META_INJECT_TOKEN,
      handler,
    );

    if (!meta) {
      throw new ServerError(`Resource ${handler.name} is not exposed`);
    }

    return meta;
  }

  public isResourcePublic(): boolean {
    const meta = this.getMetaOrThrow();

    return meta.isPublic;
  }
}
