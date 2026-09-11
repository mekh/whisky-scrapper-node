/**
 * Connection and behaviour settings for the catalogue cache.
 *
 * The connection half exists so the cache can be pointed at a **different**
 * Valkey instance from the one holding auth sessions, which is the one
 * operational decision this feature forces. A cache and a session store want
 * opposite things from a full instance: the cache wants its oldest entries
 * evicted, the sessions must never be evicted at all (a missing session key
 * is read as a revoked session and logs the user out of every device). No
 * single `maxmemory-policy` serves both, so production gives the cache its
 * own instance while development points both names at the same one.
 *
 * Every connection field falls back to its `VALKEY_*` equivalent, so sharing
 * is the zero-configuration default and splitting is one variable.
 */
export interface CacheSettings {
  /**
   * Whether the cache serves reads and records writes at all.
   *
   * The kill switch. With it off every `getOrCompute` runs its loader and
   * every bump is a no-op, which is exactly the behaviour that predates the
   * cache. It does not stop the client from connecting: the connection is
   * opened by the module graph, and the default host is the session
   * instance, which is running anyway.
   */
  enabled: boolean;

  /**
   * Whether this process bumps the generation once at startup.
   *
   * True for anything that serves reads, and that is the whole point of the
   * bump: it supersedes every write the process could not see because it was
   * not running — the migrations a deploy applied, the knowledge-base pass
   * during startup, a script run overnight.
   *
   * False for a process that serves no reads. The standalone scripts carry
   * this module only so they can invalidate the *API's* cache when they
   * finish, and a bump at their startup does nothing but discard entries the
   * script is about to make stale anyway — including on a dry run, which
   * must change nothing at all.
   */
  bootBump: boolean;

  /**
   * How long a stored entry lives, in seconds.
   *
   * Garbage collection, not freshness. Freshness comes from the generation
   * in the key, which changes on every catalogue write; this only bounds how
   * long the entries of superseded generations occupy memory, and how long a
   * bump that never happened (a process killed between commit and bump, a
   * script run against a live app) can be believed.
   */
  ttlSec: number;

  /**
   * How long one cache read may take before it is abandoned as a miss, in
   * milliseconds.
   *
   * Deliberately far below the client's own `commandTimeout`: that one is
   * there to stop an outage, this one to stop a *slow* cache from being
   * slower than the query it is meant to replace. A cache that cannot answer
   * in a fraction of the query's time has nothing to offer the request.
   */
  readTimeoutMs: number;

  /**
   * The largest entry that may be stored, in bytes, measured after
   * compression.
   *
   * A bound on one pathological filter rather than on normal use: the whole
   * unfiltered catalogue compresses to about a megabyte, so the cap only
   * refuses something far outside that.
   */
  maxEntryBytes: number;

  /**
   * Hostname of the Valkey instance holding the cache.
   */
  host: string;

  /**
   * Port of that instance.
   */
  port: number;

  /**
   * Logical database index, or undefined to use the server default.
   */
  db: number | undefined;

  /**
   * Password, or undefined when the server takes none.
   */
  password: string | undefined;

  /**
   * Prefix the client prepends to every key. This is the deployment's
   * namespace; the cache's own `cache:` root is part of the key it builds.
   */
  keyPrefix: string;

  /**
   * How long one command may wait for its reply before the client rejects
   * it, in milliseconds.
   */
  commandTimeoutMs: number;

  /**
   * How long a connection attempt may take, in milliseconds.
   */
  connectTimeoutMs: number;

  /**
   * TCP keep-alive delay, in milliseconds.
   */
  keepAliveMs: number;

  /**
   * How many times one command may be retried before it is rejected.
   */
  maxRetriesPerRequest: number;
}

/**
 * What one cached entry is, apart from the generation it belongs to.
 *
 * The generation is passed separately because it is read from the cache
 * rather than supplied by the caller — the caller states *what* it is
 * caching, the service states *when*.
 */
export interface CacheEntryRef {
  /**
   * The family of entries this one belongs to (`report`, `meta`), which
   * becomes the second segment of the key.
   */
  scope: string;

  /**
   * What distinguishes this entry inside its scope — for a report, the hash
   * of its filter. Empty for a scope holding a single entry.
   */
  suffix: string;
}

/**
 * A running count of what the cache has done since the process started.
 *
 * Cumulative rather than windowed: an operator reads two consecutive
 * heartbeat lines and subtracts, which is how the connection-pool numbers on
 * the same line are already read.
 */
export interface CacheStats {
  /**
   * Whether the cache is switched on at all. False makes every other number
   * here a leftover from before it was turned off.
   */
  enabled: boolean;

  /**
   * Entries served from the cache.
   */
  hits: number;

  /**
   * Entries that had to be computed and were then stored.
   */
  misses: number;

  /**
   * Cache commands that failed or timed out. Every one of them was served
   * from the database instead, so this counts degradation, not errors the
   * caller saw.
   */
  errors: number;

  /**
   * Reads that deliberately did not consult the cache: it is switched off,
   * the payload was too large to store, or a bump is outstanding.
   */
  bypasses: number;

  /**
   * The generation the last read resolved, or null when none has been read.
   */
  generation: number | null;

  /**
   * When the generation was last bumped, as epoch milliseconds, or null when
   * this process has not bumped it.
   */
  lastBumpAt: number | null;

  /**
   * Whether a bump is outstanding.
   *
   * True means a catalogue write committed but the cache could not be told,
   * so entries stored before it may be stale with nothing to supersede them.
   * While it is true the cache is bypassed entirely — serving a stale
   * catalogue is worse than serving a slow one — and every read retries the
   * bump.
   */
  dirty: boolean;
}
