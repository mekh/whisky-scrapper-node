import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Pool } from 'pg';
import { DataSource } from 'typeorm';
import { PostgresDriver } from 'typeorm/driver/postgres/PostgresDriver';

import { MetricsConfig } from '~config';
import { CoreCurrencyService } from '~core/currency';
import { StoreService } from '~domain/store';
import { VersionedCacheService } from '~lib/cache';
import {
  CacheMetricsService,
  CatalogueMetricsService,
  PlatformMetricsService,
  SyncMetricsService,
} from '~lib/metrics';
import { ErrorUtils } from '~utils';

/**
 * Refreshes the gauges that describe a state rather than an event.
 *
 * **It runs on a timer and never on scrape**, which is the rule that keeps
 * `GET /metrics` safe: a handler that ran SQL would let a misconfigured
 * Prometheus — or two of them — put the database under load nobody asked
 * for, and the endpoint is deliberately outside the rate limiter.
 *
 * Its cost is one query the API already serves on `GET /store`, plus a read
 * of the currency lookup; the pool and cache figures are in memory.
 */
@Injectable()
export class MetricsCollectorService
  implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MetricsCollectorService.name);

  private timer: NodeJS.Timeout | null = null;

  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: MetricsConfig,
    private readonly stores: StoreService,
    private readonly currencies: CoreCurrencyService,
    private readonly cache: VersionedCacheService,
    private readonly cacheMetrics: CacheMetricsService,
    private readonly catalogue: CatalogueMetricsService,
    private readonly platform: PlatformMetricsService,
    private readonly sync: SyncMetricsService,
  ) {}

  /**
   * Takes a first reading and starts the timer.
   *
   * @returns Resolves once the first reading is in.
   */
  public async onApplicationBootstrap(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    await this.collect();

    this.timer = setInterval(() => {
      void this.collect();
    }, this.config.collectIntervalMs);

    /**
     * Unreferenced so a script carrying this module exits when its work is
     * done rather than being held open by the timer.
     */
    this.timer.unref();
  }

  /**
   * Stops the timer so the process can exit.
   */
  public onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Takes one reading of everything this collector owns.
   *
   * Every failure is swallowed: a gauge that could not be refreshed is worth
   * far less than an unhandled rejection in a background timer, and the
   * stale value it leaves is visible as a flat line.
   *
   * @returns Resolves once the reading is published.
   */
  private async collect(): Promise<void> {
    this.readPool();
    this.readCache();

    await Promise.all([
      this.readStores(),
      this.readCurrencies(),
    ]);
  }

  /**
   * Publishes this replica's share of the connection pool.
   *
   * `waiting` above zero is `DB_ACQUIRE_TIMEOUT_MS` about to start failing
   * requests, and it is per replica — which the exporter's server-side view
   * cannot give.
   */
  private readPool(): void {
    try {
      const driver = this.dataSource.driver as PostgresDriver;
      const pool = driver.master as Pool | undefined;

      if (!pool) {
        return;
      }

      this.platform.pool(pool.totalCount, pool.idleCount, pool.waitingCount);
    } catch (error: unknown) {
      this.logger.debug('Pool gauges skipped: %s', ErrorUtils.text(error));
    }
  }

  /**
   * Republishes whether a cache bump is outstanding.
   *
   * The bump path already publishes it, but only when a bump happens: a
   * process that has not bumped since it started would otherwise never state
   * the flag at all.
   */
  private readCache(): void {
    this.cacheMetrics.setDirty(this.cache.stats().dirty);
  }

  /**
   * Publishes each store's switch and how fresh its last successful sync is.
   *
   * @returns Resolves once the stores have been read.
   */
  private async readStores(): Promise<void> {
    try {
      const stores = await this.stores.list();

      stores.forEach((store) => {
        this.catalogue.setActive(store.slug, store.active);

        if (store.lastSuccessfulSyncAt) {
          this.sync.setLastSuccess(store.slug, store.lastSuccessfulSyncAt);
        }
      });
    } catch (error: unknown) {
      this.logger.warn('Store gauges skipped: %s', ErrorUtils.text(error));
    }
  }

  /**
   * Publishes how fresh each currency's stored rates are.
   *
   * @returns Resolves once the rates have been read.
   */
  private async readCurrencies(): Promise<void> {
    try {
      const rates = await this.currencies.findLatestRates();

      rates.forEach((rate) => {
        this.platform.currencyFresh(rate.code, new Date(rate.effectiveOn));
      });
    } catch (error: unknown) {
      this.logger.warn('Currency gauges skipped: %s', ErrorUtils.text(error));
    }
  }
}
