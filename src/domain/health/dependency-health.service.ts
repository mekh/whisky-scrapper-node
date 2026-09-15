import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorResult,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';

import { DependencyMetricsService } from '~lib/metrics';
import type { HealthDependency } from '~types';

import { CacheHealthIndicator } from './indicators/cache-health.indicator';
import { ValkeyHealthIndicator } from './indicators/valkey-health.indicator';

/**
 * How long the database may take to answer `SELECT 1` before it counts as
 * down. Well under `DB_ACQUIRE_TIMEOUT_MS`, so a drained pool shows up here
 * as a failure rather than as a probe that waits with it.
 */
const DB_TIMEOUT_MS = 2000;

/**
 * Key the database reports under, matching its metric label.
 */
const DB_KEY: HealthDependency = 'postgres';

/**
 * Runs the dependency probes and publishes what they found.
 *
 * One code path serves three callers — `GET /health`, `GET /health/ready` and
 * the periodic collector — so the endpoint and the `whisky_dependency_up`
 * gauge can never disagree about whether a dependency is up.
 */
@Injectable()
export class DependencyHealthService {
  /**
   * Reads a terminus result into the shape the gauges want.
   *
   * @param result - The health check's own result object.
   * @returns One entry per probed dependency.
   */
  private static toReadings(
    result: HealthCheckResult,
  ): { key: string; up: boolean; elapsedMs: number }[] {
    return Object.entries(result.details).map(([key, detail]) => {
      const record = detail as {
        status?: string;
        responseTime?: number;
        reachable?: boolean;
      };

      /**
       * `reachable` wins where an indicator states it. The cache's status is
       * always `up` — it fails open, so it must not fail the health check —
       * and reading the status here would publish a gauge saying a cache
       * nobody can reach is fine, which is exactly what its alert watches.
       */
      return {
        key,
        up: record.reachable ?? record.status !== 'down',
        elapsedMs: record.responseTime ?? 0,
      };
    });
  }

  public constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly valkey: ValkeyHealthIndicator,
    private readonly cache: CacheHealthIndicator,
    private readonly metrics: DependencyMetricsService,
  ) {}

  /**
   * Probes Postgres and both Valkeys, records the gauges, and answers what it
   * found.
   *
   * @returns The health check result when nothing is down.
   * @throws {ServiceUnavailableException} When a hard dependency is down,
   * carrying the same result object so the 503 still names which one.
   */
  public async check(): Promise<HealthCheckResult> {
    try {
      const result = await this.runChecks();

      this.publish(result);

      return result;
    } catch (error: unknown) {
      if (error instanceof ServiceUnavailableException) {
        this.publish(error.getResponse() as HealthCheckResult);
      }

      throw error;
    }
  }

  /**
   * Runs the three probes as one health check.
   *
   * @returns The health check result.
   */
  private runChecks(): Promise<HealthCheckResult> {
    return this.health.check([
      (): Promise<HealthIndicatorResult> =>
        this.db.pingCheck(DB_KEY, { timeout: DB_TIMEOUT_MS }),
      (): Promise<HealthIndicatorResult> => this.valkey.check(),
      (): Promise<HealthIndicatorResult> => this.cache.check(),
    ]);
  }

  /**
   * Copies a result's verdicts into the gauges.
   *
   * @param result - The health check result, from success or from a 503.
   */
  private publish(result: HealthCheckResult): void {
    DependencyHealthService.toReadings(result).forEach((reading) => {
      this.metrics.record(
        reading.key as HealthDependency,
        reading.up,
        reading.elapsedMs,
      );
    });
  }
}
