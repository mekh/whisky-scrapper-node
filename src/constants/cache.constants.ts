/**
 * Browser cache window, in seconds, for the read endpoints (report, store,
 * meta). Within this window a normal reload serves the browser's cached copy;
 * a hard reload bypasses it. This governs the client's `Cache-Control` header
 * alone: the server-side catalogue cache below is addressed by generation and
 * has its own, unrelated lifetime, so the two never have to agree.
 */
export const READ_CACHE_MAX_AGE_SECONDS = 600;

/**
 * First segment of every key the catalogue cache writes.
 *
 * Self-applied rather than pushed into the client's `keyPrefix`, which is
 * reserved for the deployment's own namespace. On an instance shared with
 * the auth sessions this is what keeps the two apart, the way
 * `auth:session:` already does for them.
 */
export const CACHE_KEY_ROOT = 'cache';

/**
 * The generation counter the whole catalogue hangs off.
 *
 * One counter, not one per report kind or per table: a report page mixes
 * every store and bottling, and a catalogue write can touch any of them, so
 * nothing finer would be honest.
 */
export const CACHE_GENERATION_CATALOGUE = 'catalogue';

/**
 * Key scope for the report result sets.
 */
export const CACHE_SCOPE_REPORT = 'report';

/**
 * Key scope for the `/meta` payload.
 */
export const CACHE_SCOPE_META = 'meta';

/**
 * Below this many bytes a payload is stored uncompressed.
 *
 * Compression pays for itself many times over on a report page (this JSON
 * compresses about tenfold) but not on a few hundred bytes, where the
 * round-trip through zlib costs more than the bytes it saves.
 */
export const CACHE_GZIP_MIN_BYTES = 1024;

/**
 * How long one cache command may take before it is logged as slow. Well
 * under the read deadline, so a slow line appears before a miss does.
 */
export const CACHE_SLOW_COMMAND_MS = 50;

/**
 * How much of a key's hash is kept. 128 bits of SHA-256 is far past the
 * point where a collision between two filter shapes is worth reasoning
 * about, and it keeps a key readable in `valkey-cli`.
 */
export const CACHE_HASH_LENGTH = 32;
