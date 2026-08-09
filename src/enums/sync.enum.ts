/**
 * Which engine owns a store's sync. Stored as a plain varchar on
 * `store_config.engine` (not a Postgres enum type), so unknown legacy values
 * never break a read; this enum only pins the values the app writes.
 */
export enum SyncEngine {
  /**
   * The legacy Python collector still scrapes this store and writes the DB
   * directly. The `be/` orchestrator skips it.
   */
  PYTHON = 'python',
  /**
   * The in-process TypeScript engine owns this store's sync, on demand and on
   * the schedule.
   */
  TS = 'ts',
  /**
   * Contingency only: Python scrapes this store but posts results through the
   * `be/` ingest API instead of writing the DB directly.
   */
  PYTHON_API = 'python-api',
}

/**
 * Engine assigned to a store until it is explicitly migrated.
 */
export const DEFAULT_SYNC_ENGINE = SyncEngine.PYTHON;

/**
 * What started a sync run. Stored as a plain varchar on `sync_log.trigger`;
 * null on rows written before this column existed.
 */
export enum SyncTrigger {
  /**
   * A user (or service account) triggered the run through the sync endpoint.
   */
  MANUAL = 'manual',
  /**
   * The internal scheduler triggered the run.
   */
  CRON = 'cron',
}
