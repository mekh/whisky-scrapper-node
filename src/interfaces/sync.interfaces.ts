import { ID } from './entity.interfaces';

/**
 * The terminal result of one store's sync run, written to its `sync_log` row.
 */
export interface SyncOutcome {
  /**
   * Whether the run completed without a fatal error.
   */
  success: boolean;

  /**
   * Error text when the run failed, otherwise null.
   */
  error: string | null;

  /**
   * How many products were newly inserted this run.
   */
  added: number;

  /**
   * How many products were removed (gone from the latest listing).
   */
  removed: number;

  /**
   * How many existing products were re-seen and updated.
   */
  updated: number;

  /**
   * Total products written this run (added + updated).
   */
  total: number;
}

/**
 * How one store's leg of a scheduled full sync ended. Log-only data — it never
 * crosses the API boundary.
 */
export interface SyncStoreReport {
  /**
   * The store that was scheduled.
   */
  slug: string;

  /**
   * Wall-clock time spent on this store, including the lock attempt.
   */
  durationMs: number;

  /**
   * The outcome written to the store's `sync_log` row, or null when the run
   * never started.
   */
  outcome: SyncOutcome | null;

  /**
   * Why the run never started (its group lock was held, or the store stopped
   * being syncable since the schedule was built); null when it did start.
   */
  skipReason: string | null;
}

/**
 * How one concurrency track of a scheduled full sync went. Its stores ran
 * strictly one after another, so the track duration is their sum.
 */
export interface SyncTrackReport {
  /**
   * The track's exclusivity domain: the group name, or the slug of a
   * group-less store.
   */
  key: string;

  /**
   * Wall-clock time the whole track took.
   */
  durationMs: number;

  /**
   * Per-store results, in execution order.
   */
  stores: SyncStoreReport[];
}

/**
 * The result of one scheduled full sync, as the cron job logs it.
 */
export interface SyncRunReport {
  /**
   * Wall-clock time the full sync took — the slowest track, since tracks run
   * in parallel chunks.
   */
  durationMs: number;

  /**
   * Per-track results.
   */
  tracks: SyncTrackReport[];
}

/**
 * One in-flight sync run (an open `sync_log` row joined to its store), used to
 * describe what currently holds a group/store lock.
 */
export interface RunningSync {
  /**
   * The open sync-log row id.
   */
  id: ID;

  /**
   * The store being synced.
   */
  storeId: ID;

  /**
   * The store's slug, for user-facing messages.
   */
  storeSlug: string;

  /**
   * The run's concurrency group, or null when the store is its own domain.
   */
  group: string | null;

  /**
   * When the run started (the row's `createdAt`).
   */
  startedAt: Date;

  /**
   * Products written so far, from the latest progress touch.
   */
  total: number;
}
