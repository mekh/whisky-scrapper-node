import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';

import { VersionedCacheService } from '~lib/cache';

/**
 * Key this indicator reports under, matching the metric label.
 */
const KEY = 'valkey_cache';

/**
 * Whether the catalogue cache answers.
 *
 * It reports `up` **even when the cache is gone**, carrying `degraded` and a
 * reason instead, and that is the whole point of it being a separate
 * indicator from the session store's. Every cache failure already degrades to
 * a miss and the request is served from the database, so a cache that is down
 * makes the API slower and never wrong — answering 503 for it would refuse
 * traffic the application is handling correctly.
 */
@Injectable()
export class CacheHealthIndicator {
  public constructor(
    private readonly health: HealthIndicatorService,
    private readonly cache: VersionedCacheService,
  ) {}

  /**
   * Probes the cache instance and reports what the cache itself knows.
   *
   * `dirty` rides along because it is a state nothing outside the process can
   * otherwise see: a committed write the cache was never told about, while
   * which every read bypasses the cache entirely.
   *
   * @returns The indicator result, always up, degraded when impaired.
   */
  public async check(): Promise<HealthIndicatorResult> {
    const session = this.health.check(KEY);
    const stats = this.cache.stats();

    if (!stats.enabled) {
      return session.up({ enabled: false, reachable: true, degraded: false });
    }

    const startedAt = Date.now();
    const reachable = await this.cache.ping();

    return session.up({
      enabled: true,
      /**
       * Stated separately from the status because they answer different
       * questions: the status is "may this fail the health check" and is
       * always `up` here, while this is "did the instance answer" — which is
       * what the gauge and its alert are about.
       */
      reachable,
      dirty: stats.dirty,
      generation: stats.generation,
      responseTime: Date.now() - startedAt,
      degraded: !reachable || stats.dirty,
      reason: this.reason(reachable, stats.dirty),
    });
  }

  /**
   * Names what is wrong, for the payload a person reads.
   *
   * @param reachable - Whether the instance answered.
   * @param dirty - Whether a bump is outstanding.
   * @returns The reason, or null when nothing is wrong.
   */
  private reason(reachable: boolean, dirty: boolean): string | null {
    if (!reachable) {
      return 'unreachable';
    }

    if (dirty) {
      return 'bump-outstanding';
    }

    return null;
  }
}
