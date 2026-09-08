import { Global, Module } from '@nestjs/common';
import { ClsModule, ClsService as NestClsService } from 'nestjs-cls';

import {
  HEADER_AUTH,
  HEADER_REFRESH_COOKIE,
  HEADER_USER_AGENT,
} from '~constants';
import { Req } from '~types';

import { ClsService } from './cls.service';

/**
 * Fills the best-effort logging context.
 *
 * The client's address is **not** decided here: `ClientIpMiddleware` runs
 * first and has already written it to `req.ctx`, which this copies rather
 * than re-deriving. One request, one answer — this setup used to derive its
 * own from the first of four headers, raw, two of which nothing in the stack
 * sets or strips, so a caller could choose the address that went into its own
 * session record.
 *
 * Global, so that the `ClsService` provided here resolves inside the dynamic
 * `ClsRootModule` the factory below creates — dropping the decorator fails
 * the boot with an unresolved dependency, which is a thing to know before
 * touching this file.
 */
@Global()
@Module({
  imports: [
    ClsModule.forRootAsync({
      global: true,
      inject: [
        ClsService,
      ],
      useFactory: (ctx: ClsService) => ({
        middleware: {
          mount: false,
          setup: (_: NestClsService, req: Req): void => {
            ctx.ip = req.ctx?.ip ?? req.ip;
            ctx.accessToken = req.headers[HEADER_AUTH]?.replace('Bearer ', '');
            ctx.refreshToken = req.cookies?.[HEADER_REFRESH_COOKIE];
            ctx.userAgent = req.headers[HEADER_USER_AGENT];
          },
        },
      }),
    }),
  ],
  providers: [
    ClsService,
  ],
  exports: [
    ClsService,
  ],
})
export class ContextModule {}
