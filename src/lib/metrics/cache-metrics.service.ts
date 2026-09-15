import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram } from '@prometheus-io/client';

import {
  CACHE_DURATION_BUCKETS,
  METRIC_CACHE_BUMPS,
  METRIC_CACHE_DIRTY,
  METRIC_CACHE_DURATION,
  METRIC_CACHE_GENERATION,
  METRIC_CACHE_OPERATIONS,
} from '~constants';

import { MetricsService } from './metrics.service';

/**
 * Milliseconds in a second; the cache times in milliseconds and Prometheus
 * expects seconds.
 */
const MS_PER_SEC = 1000;

/**
 * What the catalogue cache is doing.
 *
 * The counters mirror the ones `VersionedCacheService` already keeps for its
 * `stats()` call; what is new is that they leave the process, and that
 * `dirty` becomes visible at all — a committed write the cache was never told
 * about, during which every read bypasses the cache, and which nothing
 * outside the process could previously see.
 */
@Injectable()
export class CacheMetricsService {
  private readonly operations: Counter<string>;

  private readonly duration: Histogram<string>;

  private readonly bumps: Counter<string>;

  private readonly generation: Gauge<string>;

  private readonly dirty: Gauge<string>;

  public constructor(private readonly metrics: MetricsService) {
    this.operations = this.metrics.counter({
      name: METRIC_CACHE_OPERATIONS,
      help: 'Cache lookups by outcome: hit, miss, bypass or error.',
      labelNames: [
        'result',
      ],
    });

    this.duration = this.metrics.histogram({
      name: METRIC_CACHE_DURATION,
      help: 'How long one cache command took.',
      labelNames: [
        'operation',
      ],
      buckets: CACHE_DURATION_BUCKETS,
    });

    this.bumps = this.metrics.counter({
      name: METRIC_CACHE_BUMPS,
      help: 'Generation bumps, by what caused them.',
      labelNames: [
        'reason',
      ],
    });

    this.generation = this.metrics.gauge({
      name: METRIC_CACHE_GENERATION,
      help: 'The catalogue generation entries are currently stored under.',
    });

    this.dirty = this.metrics.gauge({
      name: METRIC_CACHE_DIRTY,
      help: '1 while a committed write has not been announced to the cache, '
        + 'during which every read bypasses it.',
    });
  }

  /**
   * Records one lookup's outcome.
   *
   * @param result - hit, miss, bypass or error.
   */
  public operation(result: string): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.operations.inc({ result });
  }

  /**
   * Records how long one command took.
   *
   * @param operation - What the command was called in the log.
   * @param elapsedMs - How long it took.
   */
  public command(operation: string, elapsedMs: number): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.duration.observe({ operation }, elapsedMs / MS_PER_SEC);
  }

  /**
   * Records a generation bump and the generation it produced.
   *
   * @param reason - The reason string the bump site passed.
   * @param generation - The new generation, when it is known.
   */
  public bumped(reason: string, generation: number | null): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.bumps.inc({ reason });

    if (generation !== null) {
      this.generation.set(generation);
    }
  }

  /**
   * Publishes whether a bump is outstanding.
   *
   * @param dirty - True while the cache is bypassed for that reason.
   */
  public setDirty(dirty: boolean): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.dirty.set(dirty ? 1 : 0);
  }
}
