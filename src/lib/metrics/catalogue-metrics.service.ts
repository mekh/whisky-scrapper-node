import { Injectable } from '@nestjs/common';
import { Gauge } from '@prometheus-io/client';

import { METRIC_CATALOGUE_STORE_ACTIVE } from '~constants';

import { MetricsService } from './metrics.service';

/**
 * Whether each store is switched on for syncing.
 *
 * Deliberately one gauge. `/dashboard/*` already answers the questions about
 * the catalogue's contents with SQL against the real history, and restating
 * those as Prometheus series would give worse answers with worse retention.
 * How stocked a store is is one of those; whether it is switched on is not,
 * because it decides whether the staleness alert beside it means anything.
 */
@Injectable()
export class CatalogueMetricsService {
  private readonly active: Gauge<string>;

  public constructor(private readonly metrics: MetricsService) {
    this.active = this.metrics.gauge({
      name: METRIC_CATALOGUE_STORE_ACTIVE,
      help: '1 when the store is switched on for syncing. A store that is '
        + 'off is expected to go stale, so its freshness alert is silenced '
        + 'by this rather than by an exception list.',
      labelNames: [
        'store',
      ],
    });
  }

  /**
   * Publishes whether a store is switched on.
   *
   * @param store - The store's slug.
   * @param active - Whether it is switched on.
   */
  public setActive(store: string, active: boolean): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.active.set({ store }, active ? 1 : 0);
  }
}
