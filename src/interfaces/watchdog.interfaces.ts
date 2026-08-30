/**
 * Connection-pool occupancy at the moment a heartbeat was taken.
 *
 * Read from the TypeORM driver's own `pg` pool, so the numbers are the ones
 * the pool actually enforces rather than a copy this process keeps.
 */
export interface WatchdogPoolStats {
  /**
   * Connections the pool currently holds, idle ones included. Never exceeds
   * the configured pool size.
   */
  total: number;

  /**
   * Connections sitting idle and immediately available to the next caller.
   */
  idle: number;

  /**
   * Callers queued for a connection because none was free. **Anything above
   * zero for more than a moment means requests are being served late**, and a
   * sustained non-zero value is the signature of a pool that the sync (or a
   * leak) has drained.
   */
  waiting: number;
}

/**
 * One heartbeat: everything the watchdog measured in a single tick.
 *
 * The shape is flat and all-numeric on purpose — it is rendered as one log
 * line, and an operator reading a stalled window has to be able to compare
 * consecutive lines by eye.
 */
export interface WatchdogSample {
  /**
   * Mean event-loop delay over the tick, in milliseconds. Normal is under a
   * millisecond; a sustained high value means synchronous work is holding the
   * loop and every request is queueing behind it.
   */
  lagMeanMs: number;

  /**
   * Worst event-loop delay observed during the tick, in milliseconds. Catches
   * a single long block that a mean would average away.
   */
  lagMaxMs: number;

  /**
   * Resident set size in megabytes.
   */
  rssMb: number;

  /**
   * Used V8 heap in megabytes.
   */
  heapMb: number;

  /**
   * How many handles and requests are keeping the loop alive. A number that
   * only ever grows is a leak — most often sockets that are never closed.
   */
  handles: number;

  /**
   * Pool occupancy, or null when the data source could not be read (the pool
   * is a driver internal, so it is treated as optional rather than assumed).
   */
  pool: WatchdogPoolStats | null;

  /**
   * Round-trip time of a `PING` to Valkey, in milliseconds, or null when the
   * ping failed or did not answer within its own timeout. **A null here with
   * everything else healthy is the exact failure this watchdog exists to
   * catch** — the session lookup on the request path talks to Valkey, so a
   * cache that stops answering stalls every authenticated request.
   */
  valkeyPingMs: number | null;
}

/**
 * What the watchdog reads from configuration.
 */
export interface WatchdogSettings {
  /**
   * Whether the heartbeat runs at all.
   */
  enabled: boolean;

  /**
   * How often a heartbeat is taken and logged, in milliseconds.
   */
  intervalMs: number;

  /**
   * Event-loop delay, in milliseconds, at or above which the heartbeat is
   * logged as a warning instead of a debug line.
   */
  lagWarnMs: number;

  /**
   * How long the Valkey ping may take before the watchdog gives up on it and
   * records a null. Must stay well below `intervalMs` so a dead cache cannot
   * make heartbeats overlap.
   */
  pingTimeoutMs: number;
}

/**
 * The slice of the TypeORM driver's connection pool the watchdog reads.
 *
 * The pool is a driver internal with no public type, so it is described here
 * structurally and every field is optional: a driver that does not expose
 * these counters must degrade to "no pool data", never to a crashed
 * heartbeat.
 */
export interface DriverPoolLike {
  /**
   * Connections currently held by the pool.
   */
  totalCount?: number;

  /**
   * Connections currently idle.
   */
  idleCount?: number;

  /**
   * Callers waiting for a connection.
   */
  waitingCount?: number;
}
