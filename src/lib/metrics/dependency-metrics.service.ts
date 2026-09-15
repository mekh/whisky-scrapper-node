import { Injectable } from '@nestjs/common';
import { Gauge, Histogram } from '@prometheus-io/client';

import {
  DEPENDENCY_DURATION_BUCKETS,
  METRIC_DEPENDENCY_DURATION,
  METRIC_DEPENDENCY_UP,
} from '~constants';
import type { HealthDependency } from '~types';

import { MetricsService } from './metrics.service';

/**
 * Milliseconds in a second; the probes time in milliseconds and Prometheus
 * expects seconds.
 */
const MS_PER_SEC = 1000;

/**
 * Whether each dependency answered, and how quickly.
 *
 * Fed from the same `HealthCheckService` run that answers `GET /health`, so
 * the gauge and the endpoint cannot disagree about whether Postgres is up —
 * two independent probes eventually would.
 */
@Injectable()
export class DependencyMetricsService {
  private readonly up: Gauge<string>;

  private readonly duration: Histogram<string>;

  public constructor(private readonly metrics: MetricsService) {
    this.up = this.metrics.gauge({
      name: METRIC_DEPENDENCY_UP,
      help: '1 when the dependency answered its probe, 0 when it did not.',
      labelNames: [
        'dependency',
      ],
    });

    this.duration = this.metrics.histogram({
      name: METRIC_DEPENDENCY_DURATION,
      help: 'How long a dependency took to answer its probe.',
      labelNames: [
        'dependency',
      ],
      buckets: DEPENDENCY_DURATION_BUCKETS,
    });
  }

  /**
   * Records one probe's verdict.
   *
   * @param dependency - Which dependency was probed.
   * @param reachable - Whether it answered at all.
   * @param elapsedMs - How long the probe took.
   */
  public record(
    dependency: HealthDependency,
    reachable: boolean,
    elapsedMs: number,
  ): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.up.set({ dependency }, reachable ? 1 : 0);
    this.duration.observe({ dependency }, elapsedMs / MS_PER_SEC);
  }
}
