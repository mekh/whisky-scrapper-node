import 'reflect-metadata';

import { ServiceUnavailableException } from '@nestjs/common';
import type {
  HealthCheckResult,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';

import { DependencyHealthService } from '../src/domain/health/dependency-health.service';
import type { CacheHealthIndicator } from '../src/domain/health/indicators/cache-health.indicator';
import type { ValkeyHealthIndicator } from '../src/domain/health/indicators/valkey-health.indicator';
import type { DependencyMetricsService } from '../src/lib/metrics/dependency-metrics.service';

interface Recorded {
  dependency: string;
  up: boolean;
  elapsedMs: number;
}

/**
 * Builds the service over a health check that answers with the given result,
 * or throws it as a 503 when `failing` is set.
 *
 * @param details - The per-dependency detail the check reports.
 * @param failing - Whether the check should refuse as terminus does.
 * @returns The service and what it recorded.
 */
function build(
  details: Record<string, unknown>,
  failing = false,
): { service: DependencyHealthService; recorded: Recorded[] } {
  const recorded: Recorded[] = [];

  const result = {
    status: failing ? 'error' : 'ok',
    details,
  } as unknown as HealthCheckResult;

  const health = {
    check: async (): Promise<HealthCheckResult> => {
      if (failing) {
        throw new ServiceUnavailableException(result);
      }

      return result;
    },
  } as unknown as HealthCheckService;

  const metrics = {
    record: (dependency: string, up: boolean, elapsedMs: number): void => {
      recorded.push({ dependency, up, elapsedMs });
    },
  } as unknown as DependencyMetricsService;

  const service = new DependencyHealthService(
    health,
    {} as TypeOrmHealthIndicator,
    {} as ValkeyHealthIndicator,
    {} as CacheHealthIndicator,
    metrics,
  );

  return { service, recorded };
}

describe('DependencyHealthService', () => {
  it('records every dependency the check reported', async () => {
    const { service, recorded } = build({
      postgres: { status: 'up', responseTime: 3 },
      valkey_session: { status: 'up', responseTime: 1 },
    });

    await service.check();

    expect(recorded).toEqual([
      { dependency: 'postgres', up: true, elapsedMs: 3 },
      { dependency: 'valkey_session', up: true, elapsedMs: 1 },
    ]);
  });

  /**
   * The cache fails open, so its indicator must never fail the health check —
   * its status stays `up` even when nobody can reach it. Reading the status
   * here would publish a gauge saying an unreachable cache is fine, which is
   * exactly what its alert watches for.
   */
  it('prefers a stated reachability over the indicator status', async () => {
    const { service, recorded } = build({
      valkey_cache: { status: 'up', reachable: false, responseTime: 0 },
    });

    await service.check();

    expect(recorded).toEqual([
      { dependency: 'valkey_cache', up: false, elapsedMs: 0 },
    ]);
  });

  it('reads a down status when no reachability is stated', async () => {
    const { service, recorded } = build({
      valkey_session: { status: 'down', responseTime: 0 },
    });

    await service.check();

    expect(recorded[0]?.up).toBe(false);
  });

  /**
   * A 503 is the case the gauges matter most in, so the refusal must not
   * skip publishing them on its way out.
   */
  it('still records the gauges when the check refuses', async () => {
    const { service, recorded } = build(
      {
        postgres: { status: 'up', responseTime: 2 },
        valkey_session: { status: 'down', responseTime: 0 },
      },
      true,
    );

    await expect(service.check()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(recorded).toEqual([
      { dependency: 'postgres', up: true, elapsedMs: 2 },
      { dependency: 'valkey_session', up: false, elapsedMs: 0 },
    ]);
  });

  it('answers the result the check produced', async () => {
    const details = { postgres: { status: 'up' } };
    const { service } = build(details);

    await expect(service.check()).resolves.toMatchObject({ details });
  });
});
