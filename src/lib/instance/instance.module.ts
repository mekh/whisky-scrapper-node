import { Module } from '@nestjs/common';

import { ValkeyModule } from '~lib/valkey';

import { InstanceService } from './instance.service';

/**
 * Wires this process's identity and heartbeat. One provider, so every caller
 * asking who this instance is gets the same answer.
 */
@Module({
  imports: [
    ValkeyModule,
  ],
  providers: [
    InstanceService,
  ],
  exports: [
    InstanceService,
  ],
})
export class InstanceModule {}
