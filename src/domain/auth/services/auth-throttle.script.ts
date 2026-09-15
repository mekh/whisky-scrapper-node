/**
 * Command name the attempt check is registered under on the client.
 */
export const AUTH_THROTTLE_ATTEMPT_COMMAND = 'authThrottleAttempt';

/**
 * Command name the failure record is registered under on the client.
 */
export const AUTH_THROTTLE_FAILURE_COMMAND = 'authThrottleFailure';

/**
 * Decides whether one login attempt may proceed and stamps it, in one atomic
 * step.
 *
 * Deciding and stamping have to happen together: read-then-write lets two
 * attempts that arrive in the same moment both read "the last attempt was
 * long ago" and both pass, which is precisely the burst the one-per-second
 * floor exists to stop. The clock is the server's, so instances whose own
 * clocks disagree cannot shorten one another's penalties.
 *
 * A refused attempt writes nothing — it neither moves the stamp nor refreshes
 * the retention — so hammering a closed door cannot extend the wait.
 *
 * `KEYS[1]` is the caller's ladder; `ARGV[1]` the minimum spacing in
 * milliseconds and `ARGV[2]` the retention in seconds. Answers four
 * integers: whether to allow, the wait in milliseconds when not, the
 * failures recorded so far, and how long any penalty in force still has to
 * run. The last two are the caller's standing, which every answer states so
 * that a client can show the door closing rather than only report it shut;
 * the failure count is handed over raw and turned into "attempts left" by
 * the service, which is where the run length is already stated.
 */
export const AUTH_THROTTLE_ATTEMPT_SCRIPT = `
local key = KEYS[1]
local interval = tonumber(ARGV[1])
local retention = tonumber(ARGV[2])
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local stored = redis.call(
  'HMGET', key, 'blockedUntil', 'lastAttemptAt', 'failures'
)
local blockedUntil = tonumber(stored[1]) or 0
local lastAttemptAt = tonumber(stored[2]) or 0
local failures = tonumber(stored[3]) or 0
local blockedFor = blockedUntil - nowMs

if blockedFor < 0 then
  blockedFor = 0
end

if blockedFor > 0 then
  return {0, blockedFor, failures, blockedFor}
end

local sinceLast = nowMs - lastAttemptAt

if sinceLast >= 0 and sinceLast < interval then
  return {0, interval - sinceLast, failures, 0}
end

redis.call('HSET', key, 'lastAttemptAt', nowMs)
redis.call('EXPIRE', key, retention)

return {1, 0, failures, 0}
`;

/**
 * Records one failed attempt and imposes the next penalty when a run of them
 * is exhausted, in one atomic step.
 *
 * Atomic because the increment is the whole point: two failures landing
 * together used to read the same count and write the same number back, so one
 * guess was free — a race that existed on a single process and became routine
 * with several.
 *
 * `KEYS[1]` is the caller's ladder; `ARGV[1]` the attempts one run allows,
 * `ARGV[2]` the retention in seconds, and `ARGV[3..]` the penalty ladder in
 * seconds, whose last rung repeats forever. Answers the two integers the
 * caller's standing is made of: the failures now recorded, and the penalty
 * this very failure imposed. The write is still the point — the answer is
 * what lets the `401` say how much of the run is left, which is the whole
 * reason a person sees the last attempts coming.
 */
export const AUTH_THROTTLE_FAILURE_SCRIPT = `
local key = KEYS[1]
local perStage = tonumber(ARGV[1])
local retention = tonumber(ARGV[2])
local rungs = #ARGV - 2
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local stored = redis.call('HMGET', key, 'failures', 'stage')
local failures = (tonumber(stored[1]) or 0) + 1
local stage = tonumber(stored[2]) or 0

local blockedFor = 0

if failures < perStage then
  redis.call('HSET', key, 'failures', failures, 'lastAttemptAt', nowMs)
else
  blockedFor = tonumber(ARGV[2 + math.min(stage + 1, rungs)]) * 1000
  failures = 0

  redis.call(
    'HSET',
    key,
    'failures',
    0,
    'stage',
    stage + 1,
    'blockedUntil',
    nowMs + blockedFor,
    'lastAttemptAt',
    nowMs
  )
end

redis.call('EXPIRE', key, retention)

return {failures, blockedFor}
`;
