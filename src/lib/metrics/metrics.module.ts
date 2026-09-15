import { Global, Module } from '@nestjs/common';

import { ConfigModule } from '~config';

import { CacheMetricsService } from './cache-metrics.service';
import { CatalogueMetricsService } from './catalogue-metrics.service';
import { DependencyMetricsService } from './dependency-metrics.service';
import { HttpMetricsService } from './http-metrics.service';
import { LlmMetricsService } from './llm-metrics.service';
import { MetricsService } from './metrics.service';
import { PlatformMetricsService } from './platform-metrics.service';
import { SyncMetricsService } from './sync-metrics.service';

/**
 * The metrics registry and the facades that record into it.
 *
 * Global, because recorders sit in every layer — a Fastify hook, the cache,
 * the rate limiter, the sync orchestrator — and threading an import through
 * each of their modules would buy nothing. Nothing here reaches the database
 * or any other module, so it cannot create a cycle.
 */
@Global()
@Module({
  imports: [
    ConfigModule,
  ],
  providers: [
    MetricsService,
    CacheMetricsService,
    CatalogueMetricsService,
    DependencyMetricsService,
    HttpMetricsService,
    LlmMetricsService,
    PlatformMetricsService,
    SyncMetricsService,
  ],
  exports: [
    MetricsService,
    CacheMetricsService,
    CatalogueMetricsService,
    DependencyMetricsService,
    HttpMetricsService,
    LlmMetricsService,
    PlatformMetricsService,
    SyncMetricsService,
  ],
})
export class MetricsModule {}
