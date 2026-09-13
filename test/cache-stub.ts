import type { VersionedCacheService } from '~lib/cache';
import type {
  CacheEntryRef,
  CacheIndexedSet,
  CachePage,
  CachePagePicker,
} from '~types';

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
    getPage: <I, E>(
      _ref: CacheEntryRef,
      _generation: string,
      loader: () => Promise<CacheIndexedSet<I, E>>,
      pick: CachePagePicker<I>,
    ): Promise<CachePage<E>> =>
      loader().then(async (set) => {
        const picked = await pick(set.index);

        return {
          entries: picked.positions.map((position) =>
            set.entries[position] as E
          ),
          total: picked.total,
          source: 'bypass',
        };
      }),
    bump: (): Promise<void> => Promise.resolve(),
    bumpAfterCommit: (): void => undefined,
  } as unknown as VersionedCacheService;
}
