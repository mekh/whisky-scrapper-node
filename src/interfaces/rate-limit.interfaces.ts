/**
 * One bucket's refill policy: a sustained rate plus how much of it may be
 * spent at once.
 *
 * A token bucket rather than a fixed window on purpose. A single-page
 * client fans out on load — meta, a report, preferences, the collection
 * membership set and the saved filters all leave at once — so a plain
 * "N requests per second" window rejects half of a legitimate page load,
 * while a bucket with a burst allowance lets that spike through and still
 * holds the sustained rate to `ratePerSec`.
 */
export interface RateLimitRule {
  /**
   * Tokens added per second, i.e. the sustained request rate this bucket
   * allows once its burst is spent.
   */
  ratePerSec: number;

  /**
   * Bucket capacity: how many requests may arrive back-to-back before the
   * refill rate becomes the limit. Also the value reported as the limit in
   * the response headers.
   */
  burst: number;
}

/**
 * A bucket's stored state. Nothing here names the rule the bucket was
 * charged against, so a rule change takes effect on the next request
 * without any migration of live state.
 */
export interface RateLimitBucket {
  /**
   * Tokens left at {@link updatedAt}, fractional — the refill is computed
   * from elapsed time on read rather than by a timer per request.
   */
  tokens: number;

  /**
   * When the bucket was last charged, as an epoch millisecond stamp.
   */
  updatedAt: number;

  /**
   * When the bucket will hold its full burst again, as an epoch millisecond
   * stamp. Stored rather than derived so the pruning sweep can drop an idle
   * bucket without knowing which rule created it — a full bucket is
   * indistinguishable from one that never existed.
   */
  fullAt: number;
}

/**
 * The answer to one charge attempt, carrying everything the response
 * headers state.
 */
export interface RateLimitDecision {
  /**
   * Whether the request may proceed. False means no token was available and
   * nothing was charged beyond recording the attempt.
   */
  allowed: boolean;

  /**
   * The bucket's capacity, reported as `X-RateLimit-Limit`.
   */
  limit: number;

  /**
   * Whole tokens left after this attempt, reported as
   * `X-RateLimit-Remaining`.
   */
  remaining: number;

  /**
   * Milliseconds until another token is available, zero while at least one
   * already is. Reported as `X-RateLimit-Reset` on every answer and, on a
   * refusal, as `Retry-After` too — so an allowed request that happened to
   * spend the last token already tells the client when to come back.
   */
  retryAfterMs: number;
}
