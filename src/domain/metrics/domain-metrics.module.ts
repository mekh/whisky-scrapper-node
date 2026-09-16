import { Module } from '@nestjs/common';

import { ConfigModule } from '~config';
import { CoreCurrencyModule } from '~core/currency';
import { DomainHealthModule } from '~domain/health';
import { DomainStoreModule } from '~domain/store';
import { CacheModule } from '~lib/cache';

import { MetricsCollectorService } from './metrics-collector.service';
import { MetricsController } from './metrics.controller';

/**
 * The Prometheus endpoint and the collector behind its gauges.
 *
 * The registry itself is provided globally by `~lib/metrics`; what is wired
 * here is the route and the timer that refreshes what cannot be recorded as
 * it happens.
 */
@Module({
  imports: [
    ConfigModule,
    CacheModule,
    CoreCurrencyModule,
    DomainHealthModule,
    DomainStoreModule,
  ],
  controllers: [
    MetricsController,
  ],
  providers: [
    MetricsCollectorService,
  ],
})
export class DomainMetricsModule {}
