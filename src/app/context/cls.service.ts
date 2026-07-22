import { Logger } from '@nestjs/common';
import { InjectableProxy } from 'nestjs-cls';

import { CtxMeta, CtxUser, ID } from '~types';

@InjectableProxy()
export class ClsService {
  private readonly logger = new Logger(ClsService.name);

  private meta: CtxMeta = {};

  public get userId(): ID | undefined {
    return this.meta.user?.id;
  }

  public set ip(ip: string | undefined) {
    this.meta.ip = ip;
  }

  public get ip(): string | undefined {
    return this.meta.ip;
  }

  public get user(): CtxUser | null {
    return this.meta.user ?? null;
  }

  public set user(data: CtxUser | null | undefined) {
    if (data) {
      this.meta.user = data;
    }
  }

  public get accessToken(): string | undefined {
    return this.meta.accessToken;
  }

  public set accessToken(token: string | undefined) {
    this.meta.accessToken = token;
  }

  public get refreshToken(): string | undefined {
    return this.meta.refreshToken;
  }

  public set refreshToken(token: string | undefined) {
    this.meta.refreshToken = token;
  }

  public get userAgent(): string | undefined {
    return this.meta.userAgent;
  }

  public set userAgent(userAgent: string | undefined) {
    this.meta.userAgent = userAgent;
  }

  public setMeta(meta: CtxMeta): void {
    this.logger.verbose('setting meta: %o', meta);

    this.meta = meta;
  }

  public getMeta(): CtxMeta {
    this.logger.verbose('returning meta: %o', this.meta);

    return this.meta;
  }
}
