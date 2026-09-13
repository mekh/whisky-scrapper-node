/**
 * First segment of every key a scheduled job claims its tick under, so
 * `valkey-cli --scan --pattern 'cron:*'` shows which jobs have run recently
 * and on which instance.
 */
export const CRON_LOCK_KEY_ROOT = 'cron';

/**
 * How long a claimed tick stays claimed.
 *
 * It is the window in which a second instance firing the same job is a
 * duplicate rather than the next tick, so it has to be far longer than any
 * clock skew between instances and far shorter than the gap between two
 * ticks. Both jobs that use it run once a day, which leaves five minutes
 * comfortably inside that range; a job that ticks more often than this would
 * need its own, shorter value.
 */
export const CRON_LOCK_TTL_SEC = 300;
