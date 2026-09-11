import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { WatchdogConfig } from '~config';
import { VersionedCacheService } from '~lib/cache';
import { ValkeyService } from '~lib/valkey';
import { WatchdogService } from '~lib/watchdog';
import type { CacheStats } from '~types';

/**
 * Builds a watchdog over stub dependencies.
 *
 * @param options - What the stubs should report: the pool object the driver
 *   exposes, the ping implementation, and config overrides.
 * @returns The service under test.
 */
function build(options: {
  pool?: unknown;
  ping?: () => Promise<string>;
  cachePing?: () => Promise<string>;
  cache?: Partial<CacheStats>;
  config?: Partial<WatchdogConfig>;
} = {}): WatchdogService {
  const config = {
    enabled: true,
    intervalMs: 10,
    lagWarnMs: 250,
    pingTimeoutMs: 30,
    ...options.config,
  } as WatchdogConfig;

  const dataSource = {
    isInitialized: true,
    driver: { master: options.pool },
  } as unknown as DataSource;

  const valkey = {
    ping: options.ping ?? ((): Promise<string> => Promise.resolve('PONG')),
  } as unknown as ValkeyService;

  const cache = {
    ping: options.cachePing
      ?? ((): Promise<string> => Promise.resolve('PONG')),
    stats: (): CacheStats => ({
      enabled: true,
      hits: 0,
      misses: 0,
      errors: 0,
      bypasses: 0,
      generation: 1,
      lastBumpAt: null,
      dirty: false,
      ...options.cache,
    }),
  } as unknown as VersionedCacheService;

  return new WatchdogService(config, dataSource, valkey, cache);
}

/**
 * Waits until a condition holds, so a case never depends on a fixed sleep
 * being long enough on a loaded machine.
 *
 * @param holds - The condition to poll.
 * @param timeoutMs - How long to keep trying before giving up.
 * @returns Resolves once the condition holds, or once the wait expires.
 */
async function until(
  holds: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!holds() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Replaces the service's histogram with fixed readings, so lag arithmetic can
 * be asserted exactly instead of being inferred from a real, jittery loop.
 *
 * @param service - The service to rig.
 * @param meanNs - Mean the histogram should report, in nanoseconds.
 * @param maxNs - Max the histogram should report, in nanoseconds.
 */
function stubHistogram(
  service: WatchdogService,
  meanNs: number,
  maxNs: number,
): void {
  (service as unknown as { histogram: unknown }).histogram = {
    mean: meanNs,
    max: maxNs,
    reset: (): void => {},
    enable: (): void => {},
    disable: (): void => {},
  };
}

describe('WatchdogService', () => {
  it('reports pool occupancy and a ping time', async () => {
    const service = build({
      pool: { totalCount: 4, idleCount: 3, waitingCount: 0 },
    });

    const sample = await service.sample();

    expect(sample.pool).toEqual({ total: 4, idle: 3, waiting: 0 });
    expect(sample.valkeyPingMs).not.toBeNull();
    expect(sample.rssMb).toBeGreaterThan(0);
  });

  it('reports no pool when the driver exposes none', async () => {
    const sample = await build().sample();

    expect(sample.pool).toBeNull();
  });

  it('gives up on a ping that never answers', async () => {
    const service = build({
      ping: (): Promise<string> => new Promise<string>(() => {}),
      config: { pingTimeoutMs: 20 },
    });

    const sample = await service.sample();

    expect(sample.valkeyPingMs).toBeNull();
  });

  it('survives a ping that fails', async () => {
    const service = build({
      ping: (): Promise<string> => Promise.reject(new Error('down')),
    });

    const sample = await service.sample();

    expect(sample.valkeyPingMs).toBeNull();
  });

  it('warns when callers are queued for a connection', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const service = build({
      pool: { totalCount: 10, idleCount: 0, waitingCount: 7 },
    });

    service.onApplicationBootstrap();
    await until(() => warn.mock.calls.length > 0);
    service.onModuleDestroy();

    const lines = warn.mock.calls.map((call) => String(call[0]));

    expect(lines.some((line) => line.includes('7 waiting'))).toBe(true);

    warn.mockRestore();
  });

  it('stays quiet on a debug line when everything is healthy', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    const service = build({
      pool: { totalCount: 2, idleCount: 2, waitingCount: 0 },
    });

    service.onApplicationBootstrap();
    await until(() => debug.mock.calls.length > 0);
    service.onModuleDestroy();

    expect(debug).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
    debug.mockRestore();
  });

  it('subtracts the sampling resolution from the reported lag', async () => {
    const service = build();

    /**
     * What an idle loop actually reports: the histogram records the whole
     * 20 ms sampling interval, so without the correction every heartbeat
     * would claim a stall that is not there.
     */
    stubHistogram(service, 21_000_000, 25_000_000);

    const sample = await service.sample();

    expect(sample.lagMeanMs).toBe(1);
    expect(sample.lagMaxMs).toBe(5);
  });

  it('never reports negative lag', async () => {
    const service = build();

    stubHistogram(service, 19_000_000, 19_500_000);

    const sample = await service.sample();

    expect(sample.lagMeanMs).toBe(0);
    expect(sample.lagMaxMs).toBe(0);
  });

  it('does not run when disabled', async () => {
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    const service = build({ config: { enabled: false } });

    service.onApplicationBootstrap();
    await until(() => debug.mock.calls.length > 0, 50);
    service.onModuleDestroy();

    expect(debug).not.toHaveBeenCalled();

    debug.mockRestore();
  });
});

describe('WatchdogService — the cache segment', () => {
  /**
   * Renders one heartbeat line.
   *
   * @param service - The service to sample.
   * @returns The line an operator would read.
   */
  const line = async (service: WatchdogService): Promise<string> => {
    const sample = await service.sample();

    return (
      service as unknown as { format: (s: typeof sample) => string }
    ).format(sample);
  };

  it('states the counters, the generation and its own ping', async () => {
    const service = build({
      cache: { hits: 12, misses: 3, errors: 1, bypasses: 2, generation: 42 },
    });

    expect(await line(service))
      .toContain('cache 12h/3m/1e/2b gen 42 ping');
  });

  it('says so plainly when the cache is off', async () => {
    const service = build({ cache: { enabled: false } });

    expect(await line(service)).toContain('cache off');
  });

  it('leads with DIRTY when a bump is outstanding', async () => {
    const service = build({ cache: { dirty: true } });

    expect(await line(service)).toContain('cache DIRTY');
  });

  it('pings the cache separately from the session store', async () => {
    /**
     * They can be different servers — production gives the cache its own so
     * it can evict, which the session instance must never do — so one
     * answering says nothing about the other.
     */
    const service = build({
      cachePing: () => Promise.reject(new Error('down')),
    });

    const sample = await service.sample();

    expect(sample.valkeyPingMs).not.toBeNull();
    expect(sample.cachePingMs).toBeNull();
  });

  it('warns when the cache instance stops answering', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const service = build({
      config: { intervalMs: 5 },
      cachePing: () => Promise.reject(new Error('down')),
    });

    service.onApplicationBootstrap();
    await until(() => warn.mock.calls.length > 0, 200);
    service.onModuleDestroy();

    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('does not warn about a cache that is switched off', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation();

    const service = build({
      config: { intervalMs: 5 },
      cache: { enabled: false },
      cachePing: () => Promise.reject(new Error('down')),
    });

    service.onApplicationBootstrap();
    await until(() => debug.mock.calls.length > 0, 200);
    service.onModuleDestroy();

    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
    debug.mockRestore();
  });
});
