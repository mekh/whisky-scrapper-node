/**
 * Browser cache window, in seconds, for the read endpoints (report, store,
 * meta). Within this window a normal reload serves the browser's cached copy;
 * a hard reload bypasses it. The API stays live-on-Postgres, so this governs
 * only the client's `Cache-Control` header, not any server-side cache.
 */
export const READ_CACHE_MAX_AGE_SECONDS = 600;
