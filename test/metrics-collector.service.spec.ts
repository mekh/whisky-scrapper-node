import 'reflect-metadata';

import { Logger, ServiceUnavailableException } from '@nestjs/common';

import type { DataSource } from 'typeorm';
import type { MetricsConfig } from '../src/config';
import type { CoreCurrencyService } from '../src/core/currency';
import type { DependencyHealthService } from '../src/domain/health';
import { MetricsCollectorService } from '../src/domain/metrics/metrics-collector.service';
import type { StoreService } from '../src/domain/store';
import type { VersionedCacheService } from '../src/lib/cache';
import type {
  CacheMetricsService,
  CatalogueMetricsService,
  PlatformMetricsService,
  SyncMetricsService,
} from '../src/lib/metrics';

interface Counters {
  /**
   * How many times the dependency probes were run.
   */
  checks: number;

  /**
   * How many times the store list was read, as the pass's other half.
   */
  stores: number;
}

/**
 * Builds the collector over stubs, with the dependency check answering as
 * given.
 *
 * @param answer - What the check does: resolve, refuse with a 503, or throw.
 * @param enabled - Whether collection is switched on.
 * @returns The collector and what its readers were asked for.
 */
function build(
  answer: 'ok' | 'down' | 'broken' = 'ok',
  enabled = true,
): { collector: MetricsCollectorService; counters: Counters } {
  const counters: Counters = { checks: 0, stores: 0 };

  const dependencies = {
    check: async (): Promise<unknown> => {
      counters.checks += 1;

      if (answer === 'down') {
        throw new ServiceUnavailableException({ status: 'error' });
      }

      if (answer === 'broken') {
        throw new TypeError('indicator is not a function');
      }

      return { status: 'ok' };
    },
  } as unknown as DependencyHealthService;

  const stores = {
    list: async (): Promise<unknown[]> => {
      counters.stores += 1;

      return [];
    },
  } as unknown as StoreService;

  const collector = new MetricsCollectorService(
    { driver: {} } as unknown as DataSource,
    { enabled, collectIntervalMs: 60_000 } as MetricsConfig,
    stores,
    {
      findLatestRates: async (): Promise<unknown[]> => [],
    } as unknown as CoreCurrencyService,
    dependencies,
    {
      stats: (): { dirty: boolean } => ({ dirty: false }),
    } as unknown as VersionedCacheService,
    { setDirty: (): void => undefined } as unknown as CacheMetricsService,
    { setActive: (): void => undefined } as unknown as CatalogueMetricsService,
    {
      pool: (): void => undefined,
      currencyFresh: (): void => undefined,
    } as unknown as PlatformMetricsService,
    { setLastSuccess: (): void => undefined } as unknown as SyncMetricsService,
  );

  return { collector, counters };
}

describe('MetricsCollectorService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs the dependency probes nothing else calls in prod', async () => {
    const { collector, counters } = build();

    await collector.onApplicationBootstrap();
    collector.onModuleDestroy();

    expect(counters.checks).toBe(1);
  });

  it('treats a dependency being down as an answer, not a failure', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const { collector, counters } = build('down');

    await collector.onApplicationBootstrap();
    collector.onModuleDestroy();

    expect(counters.checks).toBe(1);
    expect(counters.stores).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when the probe fails for any other reason', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const { collector } = build('broken');

    await collector.onApplicationBootstrap();
    collector.onModuleDestroy();

    expect(warn).toHaveBeenCalledWith(
      'Dependency gauges skipped: %s',
      expect.stringContaining('indicator is not a function'),
    );
  });

  it('collects nothing at all when metrics are switched off', async () => {
    const { collector, counters } = build('ok', false);

    await collector.onApplicationBootstrap();
    collector.onModuleDestroy();

    expect(counters.checks).toBe(0);
    expect(counters.stores).toBe(0);
  });
});
