/**
 * One caller's position on the login-attempt ladder, as the Valkey hash
 * holds it.
 *
 * Written and read only by `auth-throttle.script.ts`; it is stated here
 * because the field names are the stored contract — an operator reading a
 * blocked caller's state with `HGETALL` sees exactly these — and because the
 * integration test seeds them to reach a rung without waiting an hour for
 * it.
 */
export interface LoginThrottleState {
  /**
   * Failed attempts since the last penalty was imposed, or since the state
   * was created. Reset to zero when a penalty starts.
   */
  failures: number;

  /**
   * Which rung of the penalty ladder the next exhausted run will cost. Also
   * the count of penalties already served, which is what makes the ladder
   * climb rather than repeat.
   */
  stage: number;

  /**
   * Epoch milliseconds until which every attempt is refused, or 0 when the
   * caller is not serving a penalty.
   */
  blockedUntil: number;

  /**
   * When the last attempt was made, epoch milliseconds, for the one-per-
   * second spacing rule.
   */
  lastAttemptAt: number;
}

/**
 * The answer to one login-attempt check.
 */
export interface LoginThrottleDecision {
  /**
   * Whether the attempt may proceed to a password verification.
   */
  allowed: boolean;

  /**
   * Milliseconds until the caller may try again. Zero when allowed.
   */
  retryAfterMs: number;
}
