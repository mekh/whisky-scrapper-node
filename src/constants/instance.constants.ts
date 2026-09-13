/**
 * First segment of every key an instance's liveness is recorded under, so
 * `valkey-cli --scan --pattern 'instance:*'` lists the processes that are up.
 */
export const INSTANCE_KEY_ROOT = 'instance';

/**
 * How often a process refreshes its liveness key.
 */
export const INSTANCE_HEARTBEAT_INTERVAL_MS = 10000;

/**
 * How long a liveness key outlives its last refresh. Three beats, so a
 * process is only declared gone after missing several — a paused event loop
 * must not be mistaken for a dead one, since what follows from that is
 * sweeping the run it still holds.
 */
export const INSTANCE_HEARTBEAT_TTL_SEC = 30;

/**
 * How long past the longest a run may take before an open `sync_log` row is
 * orphaned whoever asks.
 *
 * The floor under the liveness check: every run is bounded by its store
 * timeout, so a row untouched for longer than that plus this margin cannot
 * belong to a live run — which is what still clears a stale lock while
 * Valkey, and therefore the liveness answer, is unavailable.
 */
export const SYNC_ORPHAN_AGE_MARGIN_MS = 300000;
