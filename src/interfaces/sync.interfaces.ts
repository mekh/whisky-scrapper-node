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
