import { Header, applyDecorators } from '@nestjs/common';

/**
 * Header value that forbids caching entirely, used by endpoints whose answer
 * changes from second to second (live sync status).
 */
const NO_CACHE_VALUE = 'private, no-cache, no-store, must-revalidate';

/**
 * Renders the `Cache-Control` header value for a decorator argument.
 *
 * @param value - Freshness window in seconds, or the `no-cache` literal.
 * @returns The header value to send.
 */
function headerValue(value: number | 'no-cache'): string {
  return value === 'no-cache' ? NO_CACHE_VALUE : `private, max-age=${value}`;
}

/**
 * Sets the browser cache policy of a read (GET) handler. With a number the
 * response is privately cached for that many seconds: within the window a
 * normal reload serves the browser's cached copy, a hard reload bypasses it.
 * With `'no-cache'` nothing is stored, so a polled endpoint always reaches the
 * server. `private` keeps shared caches (proxies) out of it either way.
 *
 * @param value - Freshness window in seconds, or `'no-cache'` for no caching.
 * @returns A method decorator that sets the `Cache-Control` response header.
 */
export function CacheControl(value: number | 'no-cache'): MethodDecorator {
  return applyDecorators(
    Header('Cache-Control', headerValue(value)),
  );
}
