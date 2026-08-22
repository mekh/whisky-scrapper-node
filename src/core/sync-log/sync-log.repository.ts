import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';
import { QueryFailedError } from 'typeorm';

import { BaseRepository } from '~core/_common';
import { SyncTrigger } from '~enums';
import {
  DashboardSyncDay,
  ID,
  RunningSync,
  StoreLastSync,
  SyncOutcome,
} from '~types';

import { SyncLogEntity } from './sync-log.entity';

// Postgres SQLSTATE for a unique-constraint violation.
const UNIQUE_VIOLATION = '23505';

@TypeormRepository(SyncLogEntity)
export class SyncLogRepository extends BaseRepository<SyncLogEntity> {
  /**
   * Atomically starts a run: inserts an open `sync_log` row, relying on the
   * partial unique index `sync_log_running_uindex` to reject a second
   * concurrent run for the same group (or store, when group-less). The insert
   * both records the run and acquires the lock.
   *
   * @param storeId - Store to start a run for.
   * @param group - The store's exclusivity group, or null for its own domain.
   * @param trigger - What started this run.
   * @param logFile - Name of the run's log file, or null when file logging is
   *   disabled. Recorded in the same insert so a running row never lacks it.
   * @returns The created row, or null when the group/store is already running.
   */
  public async tryStart(
    storeId: ID,
    group: string | null,
    trigger: SyncTrigger,
    logFile: string | null = null,
  ): Promise<SyncLogEntity | null> {
    try {
      const entity = this.create({
        storeId,
        group: group ?? undefined,
        trigger,
        logFile: logFile ?? undefined,
      });

      return await this.save(entity);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        return null;
      }

      throw error;
    }
  }

  /**
   * Mid-run progress touch: bumps `updatedAt` and the running total.
   *
   * @param id - Sync-log row id.
   * @param total - Products written so far.
   * @returns Resolves once the row is updated.
   */
  public async touch(id: ID, total: number): Promise<void> {
    await this.query(
      'UPDATE sync_log SET "updatedAt" = now(), total = $2 WHERE id = $1',
      [id, total],
    );
  }

  /**
   * Finalizes a run: sets `finishedAt`, `success`, `error` and the counters.
   * Clearing `success` (from null) also releases the lock — the partial unique
   * index stops covering this row.
   *
   * @param id - Sync-log row id.
   * @param outcome - The terminal result and counters.
   * @returns Resolves once the row is finalized.
   */
  public async finish(id: ID, outcome: SyncOutcome): Promise<void> {
    await this.query(
      `UPDATE sync_log SET
         "finishedAt" = now(), "updatedAt" = now(),
         success = $2, error = $3, added = $4, removed = $5,
         updated = $6, total = $7
       WHERE id = $1`,
      [
        id,
        outcome.success,
        outcome.error,
        outcome.added,
        outcome.removed,
        outcome.updated,
        outcome.total,
      ],
    );
  }

  /**
   * Closes every still-open run as interrupted. Called at boot: on a single
   * instance, any open row must be a leftover from a previous process.
   *
   * @returns How many orphaned rows were closed.
   */
  public async sweepOrphaned(): Promise<number> {
    const result = await this.createQueryBuilder()
      .update(SyncLogEntity)
      .set({
        success: false,
        error: 'Interrupted: process restarted before this run finished',
        finishedAt: () => 'now()',
        updatedAt: () => 'now()',
      })
      .where('success IS NULL')
      .execute();

    return result.affected ?? 0;
  }

  /**
   * Lists the currently running syncs (open rows joined to their store), for
   * describing what holds a lock.
   *
   * @returns One entry per in-flight run, oldest first.
   */
  public async findRunning(): Promise<RunningSync[]> {
    return this.query(
      `SELECT sl.id, sl."storeId", st.slug AS "storeSlug",
              sl."group", sl."createdAt" AS "startedAt", sl.total
       FROM sync_log sl
       JOIN store st ON st.id = sl."storeId"
       WHERE sl.success IS NULL
       ORDER BY sl."createdAt"`,
    ) as Promise<RunningSync[]>;
  }

  /**
   * The timestamp of each store's most recent successful sync, in one query.
   *
   * @returns One row per store that has ever synced successfully, carrying the
   *   latest completion time (falling back to the record's creation time).
   */
  public async lastSuccessfulByStore(): Promise<StoreLastSync[]> {
    return this.createQueryBuilder('log')
      .select('log.storeId', 'storeId')
      .addSelect('MAX(COALESCE(log.finishedAt, log.createdAt))', 'lastAt')
      .where('log.success = :success', { success: true })
      .groupBy('log.storeId')
      .getRawMany<StoreLastSync>();
  }

  /**
   * Sync-run activity aggregated per calendar day (of the run's start time):
   * run and outcome counts, the persist counters, and finished-run duration
   * stats. `total` is exposed as `itemsSeen` — it counts everything the
   * scrape saw, including the out-of-stock items persist skips, so it is not
   * `added + updated`. The range bound on `createdAt` is half-open
   * (`>= from AND < to + 1 day`) because the column is a timestamp — a
   * `BETWEEN` on bare dates would drop every run after midnight on `to`.
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
    return this.query(
      `SELECT sl."createdAt"::date::text AS date,
              COUNT(*)::int AS runs,
              COUNT(*) FILTER (WHERE sl.success)::int AS succeeded,
              COUNT(*) FILTER (WHERE sl.success IS FALSE)::int AS failed,
              COUNT(*) FILTER (WHERE sl.success IS NULL)::int AS running,
              COALESCE(SUM(sl.added), 0)::int AS added,
              COALESCE(SUM(sl.removed), 0)::int AS removed,
              COALESCE(SUM(sl.updated), 0)::int AS updated,
              COALESCE(SUM(sl.total), 0)::int AS "itemsSeen",
              ROUND(AVG(
                EXTRACT(EPOCH FROM (sl."finishedAt" - sl."createdAt")) * 1000
              ))::int AS "avgDurationMs",
              ROUND(MAX(
                EXTRACT(EPOCH FROM (sl."finishedAt" - sl."createdAt")) * 1000
              ))::int AS "maxDurationMs"
       FROM sync_log sl
       JOIN store st ON st.id = sl."storeId"
       WHERE sl."createdAt" >= $1::date
         AND sl."createdAt" < ($2::date + 1)
         AND ($3::text[] IS NULL OR st.slug = ANY($3))
       GROUP BY 1
       ORDER BY 1`,
      [from, to, stores],
    ) as Promise<DashboardSyncDay[]>;
  }

  private isUniqueViolation(error: unknown): boolean {
    return error instanceof QueryFailedError
      && (error.driverError as { code?: string }).code === UNIQUE_VIOLATION;
  }
}
