import { ExecutionContext } from '@nestjs/common';

import { HEADER_REFRESH_COOKIE, HEADER_USER_AGENT } from '~constants';
import { CtxManager, CtxMeta, CtxUser, Req } from '~types';

export class HttpContextManager implements CtxManager {
  public static create(ctx: ExecutionContext): HttpContextManager {
    return new HttpContextManager(ctx);
  }

  constructor(private readonly ctx: ExecutionContext) {}

  public get ip(): string {
    return this.getReq().ip;
  }

  public get userAgent(): string {
    return this.getReq().headers[HEADER_USER_AGENT] ?? '';
  }

  public get user(): CtxUser | null {
    return this.getContext().user ?? null;
  }

  public set user(user: CtxUser | null) {
    this.getContext().user = user;
  }

  public get sessionId(): string | undefined {
    return this.getContext().sessionId;
  }

  public set sessionId(sessionId: string | undefined) {
    this.getContext().sessionId = sessionId;
  }

  public getData<T = Req>(): T {
    return this.getReq();
  }

  public getContext<T = CtxMeta>(): T {
    const req = this.getReq();

    req.ctx ??= {};

    return req.ctx as T;
  }

  public getAccessToken(): string | undefined {
    const req = this.getReq();
    if (req.ctx?.accessToken) {
      return req.ctx.accessToken;
    }

    const [type, token] = req.headers.authorization?.split(' ') ?? [];

    req.ctx ??= {};
    req.ctx.accessToken = type === 'Bearer' && token
      ? token
      : undefined;

    return req.ctx.accessToken;
  }

  public getRefreshToken(): string | undefined {
    const req = this.getReq();
    if (req.ctx?.refreshToken) {
      return req.ctx.refreshToken;
    }

    req.ctx ??= {};
    req.ctx.refreshToken = req.cookies[HEADER_REFRESH_COOKIE];

    return req.ctx.refreshToken;
  }

  private getReq<T = Req>(): T {
    return this.ctx.switchToHttp().getRequest<T>();
  }
}
