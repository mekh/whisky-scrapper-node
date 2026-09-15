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
 * Where one caller stands on the ladder, as an answer states it.
 *
 * This is what `../web`'s login form draws under itself: the count so a
 * person can see the door closing before it shuts, and the deadline so the
 * wait is a number that moves rather than a sentence that does not. It is
 * the ladder's own standing and not the flat limiter's — the two refuse for
 * different reasons and can both be in force at once, which is why they
 * carry separate headers.
 */
export interface LoginThrottleStanding {
  /**
   * Attempts one run allows, `LOGIN_ATTEMPTS_PER_STAGE`. Stated rather than
   * assumed: a client that only learns the rule by hitting it cannot show
   * how close to it the caller is.
   */
  limit: number;

  /**
   * Failed attempts left before the next penalty. It reads `limit` again
   * while a penalty is in force, which is true — the run is granted afresh
   * when the wait ends — and is why a blocked answer is read by its
   * deadline, not by this.
   */
  remaining: number;

  /**
   * Milliseconds until the penalty in force ends, or 0 when there is none.
   * Deliberately not the same figure as `retryAfterMs` below: a refusal for
   * the one-per-second spacing states a wait here of zero, because a second
   * of spacing is not a block and must not be drawn as one.
   */
  blockedForMs: number;
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

  /**
   * What the caller may still do, for the response to state.
   */
  standing: LoginThrottleStanding;
}
