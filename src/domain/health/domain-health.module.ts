import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

/**
 * The liveness probe. No providers: the answer comes from the process being
 * able to answer at all.
 */
@Module({
  controllers: [
    HealthController,
  ],
})
export class DomainHealthModule {}
