import type { VersionedCacheService } from '~lib/cache';
import type { CacheEntryRef } from '~types';

/**
 * A cache that stores nothing and always calls the loader.
 *
 * Every suite that builds a `ReportService` or a `MetaService` by hand wants
 * this rather than a real cache: they assert what the query and the grouping
 * produce, and a second identical call returning a stored answer would prove
 * nothing about either. It is also what keeps those suites from needing a
 * live Valkey.
 *
 * The one place that does want the real thing is
 * `report-cache.integration.spec.ts`, which is about the cache itself.
 *
 * @returns A cache service that is a pass-through.
 */
export function passthroughCache(): VersionedCacheService {
  return {
    getOrCompute: <T>(
      _ref: CacheEntryRef,
      _generation: string,
      loader: () => Promise<T>,
    ): Promise<T> => loader(),
    bump: (): Promise<void> => Promise.resolve(),
    bumpAfterCommit: (): void => undefined,
  } as unknown as VersionedCacheService;
}
