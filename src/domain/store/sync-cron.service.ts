import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { SyncConfig } from '~config';

import { SyncOrchestratorService } from './sync-orchestrator.service';

import type { SyncRunReport, SyncStoreReport } from '~types';

/**
 * Registry key of the daily full-sync job. Only ever one job is registered, so
 * the name is a constant rather than derived from anything.
 */
export const SYNC_CRON_JOB_NAME = 'store-full-sync';

const MS_PER_SECOND = 1000;

const SECONDS_PER_MINUTE = 60;

/**
 * Owns the internal daily schedule of the full sync.
 *
 * The job is built by hand instead of with the `@Cron` decorator because the
 * expression and timezone come from runtime config, which a decorator argument
 * cannot read. It is registered on `onApplicationBootstrap`, not
 * `onModuleInit`: Nest runs the `onModuleInit` hooks of one module
 * concurrently (`Promise.all`), so registering there could arm the schedule
 * before `SyncOrchestratorService`'s boot sweep has released the locks left by
 * the previous process. Every `onModuleInit` is settled before any
 * `onApplicationBootstrap` runs, which gives that ordering for free.
 *
 * Shutdown needs no handling here: `ScheduleModule`'s own
 * `beforeApplicationShutdown` stops and drops every job in the registry,
 * including this one. A sync that was in flight at that moment is abandoned
 * with its `sync_log` row still open, and the next process's boot sweep closes
 * it.
 */
@Injectable()
export class SyncCronService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SyncCronService.name);

  public constructor(
    private readonly orchestrator: SyncOrchestratorService,
    private readonly scheduler: SchedulerRegistry,
    private readonly config: SyncConfig,
  ) {}

  /**
   * Arms the daily schedule when it is enabled, and says so either way — the
   * production logs have to show which of the two states this process is in.
   * An unusable `SYNC_CRON_EXPRESSION` throws here and so fails the boot,
   * deliberately: a schedule that silently never fires would go unnoticed.
   */
  public onApplicationBootstrap(): void {
    if (!this.config.cronEnabled) {
      this.logger.log(
        'Daily sync schedule is disabled (SYNC_CRON_ENABLED is not set)',
      );

      return;
    }

    const job = CronJob.from({
      cronTime: this.config.cronExpression,
      timeZone: this.config.timezone,
      onTick: (): Promise<void> => this.run(),
    });

    /**
     * `addCronJob` only registers the job (and wraps its tick in the
     * registry's error handler) — starting it is the caller's job, so it must
     * happen after registration, not through the `start` option.
     */
    this.scheduler.addCronJob(SYNC_CRON_JOB_NAME, job);
    job.start();

    this.logger.log(
      'Daily sync schedule armed: "%s" (%s), next run %s',
      this.config.cronExpression,
      this.config.timezone,
      job.nextDate().toISO(),
    );
  }

  /**
   * Runs the scheduled full sync and logs what it did. Nothing may escape: a
   * rejection here would surface as an unhandled scheduler error and tell the
   * operator nothing useful.
   *
   * @returns Resolves once the sync is done and reported.
   */
  private async run(): Promise<void> {
    this.logger.log('Scheduled full sync starting');

    try {
      const report = await this.orchestrator.runFullSync();

      this.report(report);
    } catch (error) {
      this.logger.error('Scheduled full sync crashed: %o', error);
    }
  }

  /**
   * Logs the run summary: one line for the whole sync, then one per track so
   * it is visible which track (the browser-tier one, in practice) sets the
   * total duration.
   *
   * @param report - What the orchestrator reported.
   */
  private report(report: SyncRunReport): void {
    const stores = report.tracks.flatMap((track) => track.stores);
    const failed = stores.filter((store) => store.outcome?.success === false);
    const skipped = stores.filter((store) => store.outcome === null);
    const message = 'Scheduled full sync finished in %s: %d store(s) in '
      + '%d track(s), %d ok, %d failed, %d skipped';
    const args: [string, number, number, number, number, number] = [
      this.duration(report.durationMs),
      stores.length,
      report.tracks.length,
      stores.length - failed.length - skipped.length,
      failed.length,
      skipped.length,
    ];

    if (failed.length + skipped.length > 0) {
      this.logger.warn(message, ...args);
    } else {
      this.logger.log(message, ...args);
    }

    report.tracks.forEach((track) => {
      this.logger.log(
        'Sync track %s finished in %s: %s',
        track.key,
        this.duration(track.durationMs),
        track.stores.map((store) => this.storeLine(store)).join(', '),
      );
    });
  }

  /**
   * Renders one store's leg of the run for the track line.
   *
   * @param store - The store's report.
   * @returns A `slug duration status` fragment.
   */
  private storeLine(store: SyncStoreReport): string {
    const duration = this.duration(store.durationMs);

    if (store.outcome === null) {
      return `${store.slug} ${duration} skipped`;
    }

    if (!store.outcome.success) {
      return `${store.slug} ${duration} failed`;
    }

    return `${store.slug} ${duration} ok (${store.outcome.total})`;
  }

  /**
   * Renders a duration for the log lines, which are read to explain why a run
   * took as long as it did.
   *
   * @param ms - The elapsed milliseconds.
   * @returns The duration as `Ns` or `Nm SSs`.
   */
  private duration(ms: number): string {
    const seconds = Math.round(ms / MS_PER_SECOND);
    const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
    const rest = seconds % SECONDS_PER_MINUTE;

    if (minutes === 0) {
      return `${rest}s`;
    }

    return `${minutes}m ${String(rest).padStart(2, '0')}s`;
  }
}
