import { Module } from '@nestjs/common';

import { ConfigModule } from '~config';
import { MetricsModule } from '~lib/metrics';

import { WebPushService } from './web-push.service';

@Module({
  imports: [
    ConfigModule,
    MetricsModule,
  ],
  providers: [
    WebPushService,
  ],
  exports: [
    WebPushService,
  ],
})
export class WebPushModule {}
