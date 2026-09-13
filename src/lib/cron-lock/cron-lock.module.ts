import { Module } from '@nestjs/common';

import { InstanceModule } from '~lib/instance';
import { ValkeyModule } from '~lib/valkey';

import { CronLockService } from './cron-lock.service';

/**
 * Wires the per-tick election every scheduled job goes through.
 */
@Module({
  imports: [
    InstanceModule,
    ValkeyModule,
  ],
  providers: [
    CronLockService,
  ],
  exports: [
    CronLockService,
  ],
})
export class CronLockModule {}
