import { Module } from '@nestjs/common';

import { ConfigModule } from '~config';
import { CoreWhiskyModule } from '~core/core-whisky.module';
import { WebPushModule } from '~lib/web-push';

import { PushDigestService } from './push-digest.service';
import { PushController } from './push.controller';
import { PushService } from './push.service';

@Module({
  imports: [
    ConfigModule,
    CoreWhiskyModule,
    WebPushModule,
  ],
  controllers: [
    PushController,
  ],
  providers: [
    PushService,
    PushDigestService,
  ],
  exports: [
    PushDigestService,
  ],
})
export class DomainPushModule {}
