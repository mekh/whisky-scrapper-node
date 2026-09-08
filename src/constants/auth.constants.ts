/**
 * How many failed login attempts are allowed before the next penalty, and
 * how long the ladder makes the caller wait after each such run.
 *
 * The shape is the one asked for: five attempts, then a wait, then five more,
 * with the wait growing each time. Five is enough for a person who is not
 * sure which of their passwords this is; an hour is enough that an online
 * guessing attack gets nowhere, and by the time the ladder is that high the
 * caller has already spent well over an hour to buy thirty guesses.
 */
export const LOGIN_ATTEMPTS_PER_STAGE = 5;

export const LOGIN_PENALTY_SECONDS = [5, 10, 60, 300, 900, 3600];

/**
 * Minimum spacing between two login attempts from one caller, whatever the
 * outcome. This is the "one request per second" half of the rule, and unlike
 * the ladder it counts successes too: nothing legitimate submits a login form
 * twice in the same second, while a script trying to fit its five attempts
 * into one burst is exactly what this is for.
 */
export const LOGIN_ATTEMPT_MIN_INTERVAL_MS = 1000;

/**
 * How long a caller's ladder state is kept after its last attempt.
 *
 * It has to outlast the longest penalty, or the stage would be forgotten
 * during the very wait it imposed and the ladder could never climb past its
 * first rung. Twice the longest penalty is that, plus a plain statement of
 * the amnesty: two quiet hours and the ladder starts from the bottom again.
 * A successful login does not wait for it — that clears the state outright.
 */
export const LOGIN_THROTTLE_RETENTION_SEC = 7200;
