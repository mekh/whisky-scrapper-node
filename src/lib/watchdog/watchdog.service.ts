import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { DataSource } from 'typeorm';

import { WatchdogConfig } from '~config';
import { ValkeyService } from '~lib/valkey';
import type { DriverPoolLike, WatchdogPoolStats, WatchdogSample } from '~types';

const NS_PER_MS = 1e6;

const BYTES_PER_MB = 1024 * 1024;

/**
 * Sampling resolution of the event-loop delay histogram, in milliseconds.
 * Fine enough to see a stall, coarse enough to cost nothing.
 */
const HISTOGRAM_RESOLUTION_MS = 20;

/**
 * Emits one line per interval describing what this process is actually doing.
 *
 * **It exists because of a specific silence.** On 2026-08-30 the API stopped
 * answering for 68 minutes and wrote nothing at all to the log: requests were
 * stalling in the auth guard, which runs before the logging interceptor, so
 * there was no "request started" line, no error, no trace of any kind. The
 * outage had to be reconstructed afterwards from nginx's log, PostgreSQL's
 * checkpoint timings and Valkey's save timestamps.
 *
 * A heartbeat removes that class of blindness: whatever stalls next, the log
 * either names it (a null Valkey ping, a full pool, a lagging event loop) or
 * stops entirely — and a heartbeat that stops is itself the diagnosis, since
 * it means the loop is no longer running.
 *
 * Nothing here may throw, and nothing here may hang: a diagnostic that fails
 * when the system is unhealthy is worse than none, because its silence reads
 * as health.
 */
@Injectable()
export class WatchdogService
  implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WatchdogService.name);

  private readonly histogram = monitorEventLoopDelay({
    resolution: HISTOGRAM_RESOLUTION_MS,
  });

  private timer: NodeJS.Timeout | null = null;

  private stopped = false;

  public constructor(
    private readonly config: WatchdogConfig,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly valkey: ValkeyService,
  ) {}

  /**
   * Starts the heartbeat, or says why it is not running.
   */
  public onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.log('Runtime watchdog is disabled (WATCHDOG_ENABLED=false)');

      return;
    }

    this.histogram.enable();
    this.schedule();

    this.logger.log(
      'Runtime watchdog armed: every %d ms, warning above %d ms of lag',
      this.config.intervalMs,
      this.config.lagWarnMs,
    );
  }

  /**
   * Stops the heartbeat so a shutdown is not held open by its timer.
   */
  public onModuleDestroy(): void {
    this.stopped = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.histogram.disable();
  }

  /**
   * Takes one measurement of the process and its two external dependencies.
   *
   * Public because it is worth calling directly — from a test, or from any
   * future health endpoint — and because a sample is a plain value with no
   * side effect beyond resetting the histogram window.
   *
   * @returns What the process looked like at this instant.
   */
  public async sample(): Promise<WatchdogSample> {
    const memory = process.memoryUsage();
    const lagMeanMs = this.lag(this.histogram.mean);
    const lagMaxMs = this.lag(this.histogram.max);

    this.histogram.reset();

    const valkeyPingMs = await this.pingValkey();

    return {
      lagMeanMs,
      lagMaxMs,
      rssMb: Math.round(memory.rss / BYTES_PER_MB),
      heapMb: Math.round(memory.heapUsed / BYTES_PER_MB),
      handles: this.countHandles(),
      pool: this.poolStats(),
      valkeyPingMs,
    };
  }

  /**
   * Queues the next heartbeat. The timer is unreferenced so an idle process
   * can still exit, and the chain is rescheduled only after a tick finishes,
   * which makes overlapping ticks impossible however slow a dependency gets.
   */
  private schedule(): void {
    if (this.stopped) {
      return;
    }

    this.timer = setTimeout(() => {
      void this.tick();
    }, this.config.intervalMs);

    this.timer.unref();
  }

  /**
   * Takes a sample, logs it, and queues the next one. Swallows everything: a
   * broken heartbeat must not take down the process it is watching.
   *
   * @returns Resolves once the heartbeat has been written.
   */
  private async tick(): Promise<void> {
    try {
      const sample = await this.sample();
      const line = this.format(sample);

      if (this.isDegraded(sample)) {
        this.logger.warn(line);
      } else {
        this.logger.debug(line);
      }
    } catch (error) {
      this.logger.warn('Watchdog sample failed: %o', error);
    } finally {
      this.schedule();
    }
  }

  /**
   * Reads the connection pool of the default data source.
   *
   * @returns The pool's occupancy, or null when the driver does not expose it
   *   (or the data source is not initialized yet).
   */
  private poolStats(): WatchdogPoolStats | null {
    if (!this.dataSource.isInitialized) {
      return null;
    }

    const driver = this.dataSource.driver as { master?: DriverPoolLike };
    const pool = driver.master;

    if (!pool || typeof pool.totalCount !== 'number') {
      return null;
    }

    return {
      total: pool.totalCount,
      idle: pool.idleCount ?? 0,
      waiting: pool.waitingCount ?? 0,
    };
  }

  /**
   * Times a `PING` to Valkey under its own deadline.
   *
   * The deadline is not redundant with the client's `commandTimeout`: this is
   * the one call that has to survive a client whose own timeouts were
   * misconfigured, so it never trusts the client to come back.
   *
   * @returns Round-trip time in milliseconds, or null when the ping failed or
   *   did not answer in time.
   */
  private async pingValkey(): Promise<number | null> {
    const startedAt = Date.now();

    const expired = new Promise<null>((resolve) => {
      const timer = setTimeout(() => {
        resolve(null);
      }, this.config.pingTimeoutMs);

      timer.unref();
    });

    const ping = this.valkey.ping()
      .then(() => Date.now() - startedAt)
      .catch(() => null);

    return Promise.race([ping, expired]);
  }

  /**
   * Counts what is currently keeping the event loop alive.
   *
   * @returns The number of active resources, or 0 on a runtime that does not
   *   report them.
   */
  private countHandles(): number {
    if (typeof process.getActiveResourcesInfo !== 'function') {
      return 0;
    }

    return process.getActiveResourcesInfo().length;
  }

  /**
   * Decides whether this heartbeat deserves a warning rather than a debug
   * line. Any one of the three is enough — they are the three ways the
   * request path has actually been observed to stall.
   *
   * @param sample - The heartbeat to judge.
   * @returns True when something in the sample is out of order.
   */
  private isDegraded(sample: WatchdogSample): boolean {
    return sample.lagMaxMs >= this.config.lagWarnMs
      || sample.valkeyPingMs === null
      || (sample.pool?.waiting ?? 0) > 0;
  }

  /**
   * Renders a sample as the single line an operator reads.
   *
   * @param sample - The heartbeat to render.
   * @returns The log message.
   */
  private format(sample: WatchdogSample): string {
    const pool = sample.pool
      ? `${sample.pool.total} open/${sample.pool.idle} idle/`
        + `${sample.pool.waiting} waiting`
      : 'unavailable';
    const valkey = sample.valkeyPingMs === null
      ? 'NO ANSWER'
      : `${sample.valkeyPingMs} ms`;

    return `heartbeat: loop lag ${sample.lagMeanMs}/${sample.lagMaxMs} ms `
      + `(mean/max), rss ${sample.rssMb} MB, heap ${sample.heapMb} MB, `
      + `handles ${sample.handles}, db pool ${pool}, valkey ${valkey}`;
  }

  /**
   * Converts a histogram reading into event-loop lag, in milliseconds.
   *
   * The resolution is subtracted because the histogram records the whole
   * sampling interval rather than the delay on top of it: an idle loop reads
   * back as roughly the resolution, and reporting that as "lag" would make
   * every heartbeat claim a stall that is not there. The empty window a
   * histogram reports before its first sample is treated as zero.
   *
   * @param nanoseconds - The raw reading.
   * @returns The lag in milliseconds, never negative, to one decimal.
   */
  private lag(nanoseconds: number): number {
    if (!Number.isFinite(nanoseconds)) {
      return 0;
    }

    const milliseconds = nanoseconds / NS_PER_MS - HISTOGRAM_RESOLUTION_MS;

    return Math.max(0, Math.round(milliseconds * 10) / 10);
  }
}
