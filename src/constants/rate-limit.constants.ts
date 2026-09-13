/**
 * First segment of every key the rate limiter writes, so `valkey-cli --scan`
 * shows what is being tracked and the buckets stay apart from the sessions on
 * the same instance.
 */
export const RATE_LIMIT_KEY_ROOT = 'ratelimit';

/**
 * How often a run of limiter failures is summarised into one warning. A
 * limiter that cannot reach Valkey fails open on every request, so one line
 * per request would bury the outage it is reporting.
 */
export const RATE_LIMIT_FAILURE_LOG_WINDOW_MS = 60000;
