/**
 * Guard for the persist out-of-stock sweep: when a run's in-stock item count
 * falls below this fraction of the store's currently in-stock products, the
 * listing is assumed truncated (e.g. silently ended pagination) and the sweep
 * is skipped — only explicitly reported out-of-stock SKUs are flagged.
 */
export const PERSIST_SWEEP_GUARD_RATIO = 0.5;
