import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { WatchdogConfig } from '~config';
import { ValkeyService } from '~lib/valkey';
import { WatchdogService } from '~lib/watchdog';

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

  return new WatchdogService(config, dataSource, valkey);
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
