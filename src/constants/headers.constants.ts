export const HEADER_AUTH = 'authorization';
export const HEADER_REFRESH_COOKIE = 'refresh';
export const HEADER_USER_AGENT = 'user-agent';

/**
 * Default order in which forwarding headers are consulted for the client's
 * address, overridden by `APP_TRUSTED_IP_HEADERS`.
 *
 * It holds exactly the two headers `web/scripts/nginx.conf` sets, and it is a
 * **trust** order rather than a preference: every entry is a request header,
 * and a request header is client input until a proxy overwrites it.
 * `X-Real-IP` comes first because nginx sets it with `$remote_addr`, which
 * *replaces* whatever arrived; `X-Forwarded-For` is set with
 * `$proxy_add_x_forwarded_for`, which *appends*, so only its last hop is the
 * address nginx vouches for — which is what `ClientIpUtils` reads out of any
 * header, a replace-style one having a single hop anyway.
 *
 * Deliberately absent: `x-client-ip` and `cf-connecting-ip`, which nothing in
 * this stack sets **or strips**, so they arrive purely from the client. Put
 * `cf-connecting-ip` at the head of `APP_TRUSTED_IP_HEADERS` when Cloudflare
 * is genuinely in front — and strip it at the edge for requests that did not
 * come through Cloudflare, or trusting it hands a caller its own identity.
 */
export const DEFAULT_TRUSTED_IP_HEADERS = [
  'x-real-ip',
  'x-forwarded-for',
];

/**
 * Rate-limit response headers. Every answer carries the first three, so a
 * client can pace itself before it is ever refused; a `429` additionally
 * carries `Retry-After` (whole seconds, as RFC 9110 requires) and the
 * millisecond-precision variant beside it, because rounding a 340 ms wait up
 * to a second is most of a page load spent idle.
 */
export const HEADER_RATE_LIMIT = 'X-RateLimit-Limit';
export const HEADER_RATE_LIMIT_REMAINING = 'X-RateLimit-Remaining';
export const HEADER_RATE_LIMIT_RESET = 'X-RateLimit-Reset';
export const HEADER_RATE_LIMIT_RETRY_MS = 'X-RateLimit-Retry-After-Ms';
export const HEADER_RETRY_AFTER = 'Retry-After';
