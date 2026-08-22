import { Module } from '@nestjs/common';

import { ConfigModule } from '~config';

import { WebPushService } from './web-push.service';

@Module({
  imports: [
    ConfigModule,
  ],
  providers: [
    WebPushService,
  ],
  exports: [
    WebPushService,
  ],
})
export class WebPushModule {}
