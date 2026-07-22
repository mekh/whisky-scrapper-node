import { Global, Module } from '@nestjs/common';
import { ClsModule, ClsService as NestClsService } from 'nestjs-cls';

import {
  HEADERS_IP,
  HEADER_AUTH,
  HEADER_REFRESH_COOKIE,
  HEADER_USER_AGENT,
} from '~constants';
import { Request } from '~types';

import { ClsService } from './cls.service';

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
          setup: (_: NestClsService, req: Request): void => {
            ctx.ip = HEADERS_IP.reduce(
              (acc, header) => acc || req.headers[header],
              '',
            ) || req.ip;
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
