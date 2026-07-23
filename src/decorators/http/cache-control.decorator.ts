import { Header, applyDecorators } from '@nestjs/common';

/**
 * Sets a private, time-based browser cache on a read (GET) handler. Within
 * `maxAgeSeconds` a normal reload serves the browser's cached copy; a hard
 * reload bypasses it. `private` prevents shared caches (proxies) from storing
 * the response.
 *
 * @param maxAgeSeconds - Freshness window, in seconds, for the browser cache.
 * @returns A method decorator that sets the `Cache-Control` response header.
 */
export function CacheControl(maxAgeSeconds: number): MethodDecorator {
  return applyDecorators(
    Header('Cache-Control', `private, max-age=${maxAgeSeconds}`),
  );
}
