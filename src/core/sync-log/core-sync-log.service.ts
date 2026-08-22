import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import { SyncTrigger } from '~enums';
import { DashboardSyncDay, ID, RunningSync, SyncOutcome } from '~types';

import { SyncLogEntity } from './sync-log.entity';
import { SyncLogRepository } from './sync-log.repository';

/**
 * Persistence-layer public API for the `sync_log` entity.
 */
@Injectable()
export class CoreSyncLogService extends CoreBaseService<SyncLogEntity> {
  public constructor(protected readonly repo: SyncLogRepository) {
    super(repo);
  }

  /**
   * Atomically starts a run and acquires its group/store lock.
   *
   * @param storeId - Store to start a run for.
   * @param group - The store's exclusivity group, or null for its own domain.
   * @param trigger - What started this run.
   * @param logFile - Name of the run's log file, or null when file logging is
   *   disabled.
   * @returns The created row, or null when the group/store is already running.
   */
  public async tryStart(
    storeId: ID,
    group: string | null,
    trigger: SyncTrigger,
    logFile: string | null = null,
  ): Promise<SyncLogEntity | null> {
    return this.repo.tryStart(storeId, group, trigger, logFile);
  }

  /**
   * Mid-run progress touch (bumps `updatedAt` and the running total).
   *
   * @param id - Sync-log row id.
   * @param total - Products written so far.
   * @returns Resolves once the row is updated.
   */
  public async touch(id: ID, total: number): Promise<void> {
    return this.repo.touch(id, total);
  }

  /**
   * Finalizes a run and releases its lock.
   *
   * @param id - Sync-log row id.
   * @param outcome - The terminal result and counters.
   * @returns Resolves once the row is finalized.
   */
  public async finish(id: ID, outcome: SyncOutcome): Promise<void> {
    return this.repo.finish(id, outcome);
  }

  /**
   * Closes every still-open run as interrupted (boot cleanup).
   *
   * @returns How many orphaned rows were closed.
   */
  public async sweepOrphaned(): Promise<number> {
    return this.repo.sweepOrphaned();
  }

  /**
   * Lists the currently running syncs, oldest first.
   *
   * @returns One entry per in-flight run.
   */
  public async findRunning(): Promise<RunningSync[]> {
    return this.repo.findRunning();
  }

  /**
   * The most recent sync-log entries for a store, newest first.
   *
   * @param storeId - Store id.
   * @param limit - Maximum number of entries to return.
   * @returns The store's latest sync-log entries.
   */
  public async recentByStore(
    storeId: ID,
    limit: number,
  ): Promise<SyncLogEntity[]> {
    return this.findMany(
      { storeId },
      { order: { createdAt: 'DESC' }, take: limit },
    );
  }

  /**
   * The timestamp of each store's most recent successful sync, keyed by store
   * id, for stores that have ever synced successfully.
   *
   * @returns A map of store id to the last successful sync timestamp.
   */
  public async lastSuccessfulByStore(): Promise<Map<ID, Date>> {
    const rows = await this.repo.lastSuccessfulByStore();

    return new Map(rows.map((row) => [row.storeId, row.lastAt]));
  }

  /**
   * Sync-run activity aggregated per calendar day: run/outcome counts, the
   * persist counters and duration stats.
   *
   * @param from - Inclusive range start (`YYYY-MM-DD`).
   * @param to - Inclusive range end (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @returns One row per day that had runs, ascending by date.
   */
  public async activityByDay(
    from: string,
    to: string,
    stores: string[] | null,
  ): Promise<DashboardSyncDay[]> {
    return this.repo.activityByDay(from, to, stores);
  }
}
