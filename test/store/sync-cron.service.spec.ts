import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { CronJob } from 'cron';

import {
  SYNC_CRON_JOB_NAME,
  SyncCronService,
} from '../../src/domain/store/sync-cron.service';

import type { SchedulerRegistry } from '@nestjs/schedule';
import type { CronJobParams } from 'cron';
import type { SyncConfig } from '~config';
import type { SyncRunReport } from '~types';
import type { SyncOrchestratorService } from '../../src/domain/store/sync-orchestrator.service';

interface Fakes {
  /**
   * The service under test.
   */
  cron: SyncCronService;

  /**
   * The orchestrator whose `runFullSync` the job body drives.
   */
  orchestrator: { runFullSync: jest.Mock };

  /**
   * The scheduler registry the job is registered with.
   */
  scheduler: { addCronJob: jest.Mock };

  /**
   * The job stub `CronJob.from` is made to return.
   */
  job: { start: jest.Mock; nextDate: jest.Mock };

  /**
   * The spy over `CronJob.from`, holding the params the job was built with.
   */
  from: jest.SpyInstance;
}

const REPORT: SyncRunReport = {
  durationMs: 90_000,
  tracks: [
    {
      key: 'zakaz',
      durationMs: 60_000,
      stores: [
        {
          slug: 'metro',
          durationMs: 30_000,
          outcome: {
            success: true,
            error: null,
            added: 1,
            removed: 0,
            updated: 2,
            total: 3,
          },
          skipReason: null,
        },
        {
          slug: 'novus',
          durationMs: 30_000,
          outcome: null,
          skipReason: 'Store novus shares the "zakaz" sync group with metro',
        },
      ],
    },
    {
      key: 'maudau',
      durationMs: 90_000,
      stores: [
        {
          slug: 'maudau',
          durationMs: 90_000,
          outcome: {
            success: false,
            error: 'boom',
            added: 0,
            removed: 0,
            updated: 0,
            total: 0,
          },
          skipReason: null,
        },
      ],
    },
  ],
};

/**
 * Wires the cron service with plain fakes and a stubbed `CronJob.from`, so no
 * real timer is ever created.
 *
 * @param over - Overrides for the sync config defaults.
 * @returns The service plus the fakes it was built with.
 */
function makeCron(over: Partial<SyncConfig> = {}): Fakes {
  const orchestrator = {
    runFullSync: jest.fn().mockResolvedValue(REPORT),
  };

  const scheduler = {
    addCronJob: jest.fn(),
  };

  const job = {
    start: jest.fn(),
    nextDate: jest.fn().mockReturnValue({ toISO: (): string => 'next' }),
  };

  const from = jest
    .spyOn(CronJob, 'from')
    .mockReturnValue(job as unknown as CronJob);

  const config = {
    cronEnabled: true,
    cronExpression: '0 12 * * *',
    timezone: 'Europe/Kyiv',
    maxParallelTracks: 4,
    storeTimeoutMs: 900000,
    browserStoreTimeoutMs: 2700000,
    ...over,
  } as SyncConfig;

  const cron = new SyncCronService(
    orchestrator as unknown as SyncOrchestratorService,
    scheduler as unknown as SchedulerRegistry,
    config,
  );

  return { cron, orchestrator, scheduler, job, from };
}

/**
 * Reads the tick callback the registered job was built with.
 *
 * @param from - The `CronJob.from` spy.
 * @returns The job body.
 */
function tickOf(from: jest.SpyInstance): () => Promise<void> {
  const [params] = from.mock.calls[0] as [CronJobParams];

  return params.onTick as () => Promise<void>;
}

describe('SyncCronService.onApplicationBootstrap', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers no job when the schedule is disabled', () => {
    const { cron, scheduler, from } = makeCron({ cronEnabled: false });
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();

    cron.onApplicationBootstrap();

    expect(from).not.toHaveBeenCalled();
    expect(scheduler.addCronJob).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('disabled');
  });

  it('registers exactly one job with the configured schedule', () => {
    const { cron, scheduler, job, from } = makeCron({
      cronExpression: '*/5 * * * *',
      timezone: 'UTC',
    });

    jest.spyOn(Logger.prototype, 'log').mockImplementation();

    cron.onApplicationBootstrap();

    expect(from).toHaveBeenCalledTimes(1);

    const [params] = from.mock.calls[0] as [CronJobParams];

    expect(params.cronTime).toBe('*/5 * * * *');
    expect(params.timeZone).toBe('UTC');
    expect(scheduler.addCronJob).toHaveBeenCalledTimes(1);
    expect(scheduler.addCronJob).toHaveBeenCalledWith(
      SYNC_CRON_JOB_NAME,
      job,
    );
    expect(job.start).toHaveBeenCalledTimes(1);
  });
});

describe('SyncCronService job body', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs a full sync and logs the run summary', async () => {
    const { cron, orchestrator, from } = makeCron();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    cron.onApplicationBootstrap();
    await tickOf(from)();

    expect(orchestrator.runFullSync).toHaveBeenCalledTimes(1);

    /**
     * The summary is a warning because this report holds a failure and a skip.
     */
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('%d ok, %d failed, %d skipped');
    expect(warn.mock.calls[0].slice(1)).toEqual(['1m 30s', 3, 2, 1, 1, 1]);

    const tracks = log.mock.calls.filter((call) =>
      String(call[0]).startsWith('Sync track')
    );

    expect(tracks).toHaveLength(2);
    expect(tracks[0].slice(1)).toEqual([
      'zakaz',
      '1m 00s',
      'metro 30s ok (3), novus 30s skipped',
    ]);
    expect(tracks[1].slice(1)).toEqual([
      'maudau',
      '1m 30s',
      'maudau 1m 30s failed',
    ]);
  });

  it('logs the summary at log level when every store succeeded', async () => {
    const { cron, orchestrator, from } = makeCron();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const clean: SyncRunReport = {
      durationMs: 5_000,
      tracks: [{
        key: 'zakaz',
        durationMs: 5_000,
        stores: [REPORT.tracks[0].stores[0]],
      }],
    };

    orchestrator.runFullSync.mockResolvedValue(clean);

    cron.onApplicationBootstrap();
    await tickOf(from)();

    expect(warn).not.toHaveBeenCalled();
    expect(
      log.mock.calls.some((call) => String(call[0]).includes('finished in')),
    ).toBe(true);
  });

  it('never lets a failed full sync escape the job', async () => {
    const { cron, orchestrator, from } = makeCron();

    jest.spyOn(Logger.prototype, 'log').mockImplementation();

    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    orchestrator.runFullSync.mockRejectedValue(new Error('boom'));

    cron.onApplicationBootstrap();

    await expect(tickOf(from)()).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toContain('crashed');
  });
});
