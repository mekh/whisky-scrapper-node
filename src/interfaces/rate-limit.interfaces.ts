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
 * One bucket to charge: which bucket, and the policy to charge it against.
 *
 * The rule travels with the charge rather than being stored beside the
 * bucket, so a changed limit takes effect on the next request with no
 * migration of live state.
 */
export interface RateLimitCharge {
  /**
   * The bucket's identity: the caller and the scope being charged, without
   * the key root the store prepends.
   */
  key: string;

  /**
   * The refill policy to apply to it.
   */
  rule: RateLimitRule;
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
