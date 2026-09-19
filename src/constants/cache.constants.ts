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
 * Which *shape* of the `/meta` payload the entry under a key holds.
 *
 * The generation counter answers "has the data changed"; it cannot answer
 * "has the code changed", and a deploy that adds a field to this payload
 * leaves the pre-deploy blob addressable under the unchanged generation.
 * Outgoing validation then rejects it and `/meta` answers 500 for everyone
 * until an unrelated catalogue write happens to bump the counter — which on
 * a quiet day is the next nightly sync. `v2` added the countries' `nameEn`.
 *
 * Bump this whenever a field is added to or removed from `MetaType`. The old
 * entry is not deleted, merely never addressed again, which is the same
 * mechanism the generation itself uses.
 */
export const CACHE_META_SHAPE = 'v2';

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
 * How long slow commands are aggregated before one summary line is written.
 *
 * A line per slow command is unusable under load: the generation read alone
 * runs once per request, so a cache having a bad minute buries every other
 * line in the log at the exact moment someone is reading it. One line per
 * operation per window carries the same information — count, min, max,
 * mean — without the flood.
 */
export const CACHE_SLOW_LOG_WINDOW_MS = 60_000;

/**
 * How much of a key's hash is kept. 128 bits of SHA-256 is far past the
 * point where a collision between two filter shapes is worth reasoning
 * about, and it keeps a key readable in `valkey-cli`.
 */
export const CACHE_HASH_LENGTH = 32;

/**
 * Key suffix of a page-addressable set's index: ids and precomputed orders.
 */
export const CACHE_SET_INDEX_SUFFIX = 'idx';

/**
 * Key suffix of a page-addressable set's entries, a hash keyed by position.
 */
export const CACHE_SET_ENTRIES_SUFFIX = 'grp';

/**
 * Fields per `HSET` when a set's entries are written, so one command never
 * carries the whole catalogue.
 */
export const CACHE_SET_HSET_CHUNK = 500;

/**
 * How many read deadlines a set write may take: it moves megabytes where a
 * read moves kilobytes, and an abandoned half-written set only costs a
 * rebuild.
 */
export const CACHE_SET_WRITE_DEADLINE_FACTOR = 4;
