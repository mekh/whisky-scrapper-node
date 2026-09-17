import { Module } from '@nestjs/common';

import { CoreWhiskyModule } from '~core/core-whisky.module';
import { ValkeyModule } from '~lib/valkey';

import { MessageBroadcastController } from './message-broadcast.controller';
import { MessageStreamService } from './message-stream.service';
import { MessageController } from './message.controller';
import { MessageService } from './message.service';

@Module({
  imports: [
    CoreWhiskyModule,
    ValkeyModule,
  ],
  controllers: [
    MessageBroadcastController,
    MessageController,
  ],
  providers: [
    MessageService,
    MessageStreamService,
  ],
  exports: [
    MessageService,
    MessageStreamService,
  ],
})
export class DomainMessageModule {}
