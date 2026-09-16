import { Module } from '@nestjs/common';

import { ConfigModule } from '~config';
import { CoreWhiskyModule } from '~core/core-whisky.module';
import { DomainMessageModule } from '~domain/message';
import { WebPushModule } from '~lib/web-push';

import { PushDigestService } from './push-digest.service';
import { PushController } from './push.controller';
import { PushService } from './push.service';

@Module({
  /**
   * `DomainMessageModule` is the second domain-to-domain import in the app,
   * after `domain/store` -> `domain/push`, and it is one-directional in the
   * same way: the inbox never reaches back for push.
   */
  imports: [
    ConfigModule,
    CoreWhiskyModule,
    DomainMessageModule,
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
