import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { CacheModule } from '~lib/cache';
import { ValkeyModule } from '~lib/valkey';

import { DependencyHealthService } from './dependency-health.service';
import { HealthController } from './health.controller';
import { CacheHealthIndicator } from './indicators/cache-health.indicator';
import { ValkeyHealthIndicator } from './indicators/valkey-health.indicator';

/**
 * The health routes and the probes behind them.
 *
 * `TerminusModule` brings `TypeOrmHealthIndicator`, which issues the
 * database's `SELECT 1` outside a repository. That is a deliberate exception
 * to the layering rule: it is a third-party probe carrying its own timeout,
 * not application code reaching into the database, and the alternative was a
 * `core/health` module with an entity-less repository invented to satisfy the
 * letter of a rule aimed at business queries.
 */
@Module({
  imports: [
    TerminusModule,
    ValkeyModule,
    CacheModule,
  ],
  controllers: [
    HealthController,
  ],
  providers: [
    DependencyHealthService,
    ValkeyHealthIndicator,
    CacheHealthIndicator,
  ],
  exports: [
    DependencyHealthService,
  ],
})
export class DomainHealthModule {}
