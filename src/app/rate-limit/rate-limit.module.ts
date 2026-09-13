import { Module } from '@nestjs/common';

import { ConfigModule } from '~config';
import { ValkeyModule } from '~lib/valkey';

import { RateLimitStore } from './rate-limit.store';
import { UserRateLimitGuard } from './user-rate-limit.guard';

/**
 * Wires the per-caller rate limiter. The buckets live in Valkey, shared by
 * every instance of the API, so the store here is a thin client over them
 * rather than the state itself.
 */
@Module({
  imports: [
    ConfigModule,
    ValkeyModule,
  ],
  providers: [
    RateLimitStore,
    UserRateLimitGuard,
  ],
  exports: [
    RateLimitStore,
    UserRateLimitGuard,
  ],
})
export class RateLimitModule {}
