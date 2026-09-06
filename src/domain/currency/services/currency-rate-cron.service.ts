import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { CurrencyConfig } from '~config';

import { CurrencyRateSyncService } from './currency-rate-sync.service';

/**
 * Registry key of the daily rate job. Only one is ever registered, so the
 * name is a constant.
 */
export const CURRENCY_RATE_CRON_JOB_NAME = 'currency-rate-sync';

/**
 * Owns the daily schedule that keeps the rate series current.
 *
 * Built by hand rather than with the `@Cron` decorator, whose arguments are
 * evaluated at class-definition time and so cannot read runtime config, and
 * registered in `onApplicationBootstrap` rather than `onModuleInit`, since
 * Nest runs one module's `onModuleInit` hooks concurrently. Shutdown needs no
 * code: `ScheduleModule`'s own `beforeApplicationShutdown` stops and drops
 * every registered job. All three points follow `SyncCronService`.
 *
 * Two things differ from that service, both deliberate.
 *
 * **This one ships enabled.** A scrape that starts on its own is a surprise
 * worth opting into; a rates table that quietly stops updating shows wrong
 * money on every screen that converts, and this job is one small request a day
 * to a government open-data API.
 *
 * **The hour is not load-bearing.** The NBU sets business day D's rate on day
 * D-1 and publishes it after 15:30 Kyiv time, so the default expression runs
 * after that and leaves the table holding the *next* business day's rate —
 * which means a failed run costs nothing. But each run also re-fetches a
 * trailing window and the write is an upsert, so any run repairs what earlier
 * ones missed, and both the expression and the timezone are env-driven.
 */
@Injectable()
export class CurrencyRateCronService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CurrencyRateCronService.name);

  public constructor(
    private readonly sync: CurrencyRateSyncService,
    private readonly scheduler: SchedulerRegistry,
    private readonly config: CurrencyConfig,
  ) {}

  /**
   * Arms the daily schedule when it is enabled, and logs which of the two
   * states this process is in either way. An unusable expression throws here
   * and so fails the boot, deliberately: a schedule that silently never fires
   * is the worse failure.
   */
  public onApplicationBootstrap(): void {
    if (!this.config.cronEnabled) {
      this.logger.log(
        'Currency rate schedule is disabled '
          + '(CURRENCY_RATE_CRON_ENABLED is false)',
      );

      return;
    }

    const job = CronJob.from({
      cronTime: this.config.cronExpression,
      timeZone: this.config.timezone,
      onTick: (): Promise<void> => this.run(),
    });

    this.scheduler.addCronJob(CURRENCY_RATE_CRON_JOB_NAME, job);
    job.start();

    this.logger.log(
      'Currency rate schedule armed: "%s" (%s), next run %s',
      this.config.cronExpression,
      this.config.timezone,
      job.nextDate().toISO(),
    );
  }

  /**
   * Runs the scheduled sync and logs what it did. Nothing may escape: a
   * rejection here would surface as an unhandled scheduler error telling the
   * operator nothing useful.
   *
   * @returns Resolves once the sync is done and reported.
   */
  private async run(): Promise<void> {
    try {
      const report = await this.sync.sync();

      this.logger.log(
        'Currency rates synced: %s %s..%s, %d day(s) fetched, %d written',
        report.codes.join(', '),
        report.from,
        report.to,
        report.fetched,
        report.written,
      );
    } catch (error) {
      this.logger.error('Scheduled currency rate sync failed: %o', error);
    }
  }
}
