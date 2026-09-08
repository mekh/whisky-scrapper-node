/**
 * Named stricter rate-limit profiles a route may opt into with the
 * `@RateLimit()` decorator, on top of the per-user cap every request pays.
 *
 * A profile is a name, not a number: the numbers live in `RateLimitConfig`
 * so they stay environment-tunable, the way every other operational limit in
 * this codebase is.
 */
export enum RateLimitProfile {
  /**
   * Endpoints that load a large result set per request — the report and
   * dashboard reads. Replaces the `THROTTLE_*` budget the retired
   * `UserThrottlerGuard` applied to exactly these two controllers.
   */
  HEAVY = 'heavy',
  /**
   * Endpoints whose single request costs several aggregate queries, where
   * one call per second per user is already generous — the collection reads.
   */
  STRICT = 'strict',
  /**
   * The two public endpoints, `POST /auth/login` and `POST /auth/refresh`.
   * They are the only routes an unauthenticated caller can reach, so the
   * bucket is keyed by address rather than by account; the ladder that
   * actually punishes repeated guessing lives in `AuthThrottleService`,
   * which needs to know whether the guess was wrong and so cannot be a
   * guard. This is the flat ceiling underneath it.
   */
  AUTH = 'auth',
}
