import { Module } from '@nestjs/common';

import { ConfigModule } from '~config';
import { ValkeyModule } from '~lib/valkey';

import { WatchdogService } from './watchdog.service';

@Module({
  imports: [
    ConfigModule,
    ValkeyModule,
  ],
  providers: [
    WatchdogService,
  ],
  exports: [
    WatchdogService,
  ],
})
export class WatchdogModule {}
