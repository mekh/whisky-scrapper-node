/**
 * Command name the charge script is registered under on the client.
 */
export const RATE_LIMIT_CONSUME_COMMAND = 'rateLimitConsume';

/**
 * How many numbers the script returns per bucket it charged.
 */
export const RATE_LIMIT_REPLY_FIELDS = 3;

/**
 * Charges a chain of token buckets in one atomic step, stopping at the first
 * that refuses.
 *
 * Atomic because the alternative — read, decide, write — loses a charge
 * whenever two requests interleave, which with several instances of the API
 * is every busy moment rather than a rare race. The clock is the server's
 * (`TIME`) for the same reason: instances whose clocks disagree would refill
 * one another's buckets at different rates.
 *
 * `KEYS[i]` is a bucket; `ARGV[2i-1]` and `ARGV[2i]` are its refill rate per
 * second and its capacity. Answers three integers per bucket charged —
 * allowed, whole tokens left, milliseconds until the next one — and stops
 * short, so a short reply is how the caller learns a bucket refused.
 */
export const RATE_LIMIT_CONSUME_SCRIPT = `
local now = redis.call('TIME')
local nowMs = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local answer = {}

for i = 1, #KEYS do
  local key = KEYS[i]
  local rate = tonumber(ARGV[i * 2 - 1])
  local burst = tonumber(ARGV[i * 2])
  local stored = redis.call('HMGET', key, 't', 'u')
  local tokens = burst

  if stored[1] and stored[2] then
    local elapsed = math.max(0, nowMs - tonumber(stored[2]))

    tokens = math.min(burst, tonumber(stored[1]) + elapsed * rate / 1000)
  end

  local allowed = 0

  if tokens >= 1 then
    allowed = 1
    tokens = tokens - 1
  end

  local full = math.max(1, math.ceil((burst - tokens) * 1000 / rate))

  redis.call('HSET', key, 't', tokens, 'u', nowMs)
  redis.call('PEXPIRE', key, full)

  local wait = 0

  if tokens < 1 then
    wait = math.ceil((1 - tokens) * 1000 / rate)
  end

  answer[#answer + 1] = allowed
  answer[#answer + 1] = math.floor(tokens)
  answer[#answer + 1] = wait

  if allowed == 0 then
    break
  end
end

return answer
`;
