import { Module } from '@nestjs/common';

import { ConfigModule } from '~config';
import { CacheModule } from '~lib/cache';
import { ValkeyModule } from '~lib/valkey';

import { WatchdogService } from './watchdog.service';

@Module({
  imports: [
    CacheModule,
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
