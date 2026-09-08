import { Module } from '@nestjs/common';

import { ConfigModule } from '~config';

import { RateLimitStore } from './rate-limit.store';
import { UserRateLimitGuard } from './user-rate-limit.guard';

/**
 * Wires the per-caller rate limiter. The store is a singleton by
 * construction — it holds the live buckets, so a second instance would be a
 * second, half-blind limiter — which is why it is provided here once and
 * exported rather than created by whoever needs it.
 */
@Module({
  imports: [
    ConfigModule,
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
