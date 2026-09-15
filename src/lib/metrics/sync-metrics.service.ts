import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram } from '@prometheus-io/client';

import {
  METRIC_SCRAPE_DEADLINE_SKIPS,
  METRIC_SCRAPE_DETAIL_PAGES,
  METRIC_SCRAPE_LISTING_INCOMPLETE,
  METRIC_SCRAPE_PAGES,
  METRIC_SCRAPE_STOCK_DROP,
  METRIC_SYNC_DURATION,
  METRIC_SYNC_IN_FLIGHT,
  METRIC_SYNC_ITEMS,
  METRIC_SYNC_LAST_SUCCESS,
  METRIC_SYNC_RUNS,
  SYNC_DURATION_BUCKETS,
} from '~constants';

import { MetricsService } from './metrics.service';

/**
 * Milliseconds in a second; runs are timed in milliseconds and Prometheus
 * expects seconds.
 */
const MS_PER_SEC = 1000;

/**
 * What the scrapers did, per store.
 *
 * Two of these answer questions nothing could answer before. The last
 * successful sync per store makes "nothing has synced rozetka in two days"
 * an alert rather than something found by opening a page and reading a date.
 * And the deadline skips make visible a run that quietly gave up on filling
 * fields and said so only inside a file on disk.
 */
@Injectable()
export class SyncMetricsService {
  private readonly runs: Counter<string>;

  private readonly duration: Histogram<string>;

  private readonly inFlight: Gauge<string>;

  private readonly lastSuccess: Gauge<string>;

  private readonly items: Counter<string>;

  private readonly pages: Counter<string>;

  private readonly detailPages: Counter<string>;

  private readonly listingIncomplete: Counter<string>;

  private readonly stockDrop: Counter<string>;

  private readonly deadlineSkips: Counter<string>;

  public constructor(private readonly metrics: MetricsService) {
    this.runs = this.metrics.counter({
      name: METRIC_SYNC_RUNS,
      help: 'Store sync runs that finished, by trigger and outcome.',
      labelNames: [
        'store',
        'trigger',
        'outcome',
      ],
    });

    this.duration = this.metrics.histogram({
      name: METRIC_SYNC_DURATION,
      help: 'How long a store sync took, start to close.',
      labelNames: [
        'store',
      ],
      buckets: SYNC_DURATION_BUCKETS,
    });

    this.inFlight = this.metrics.gauge({
      name: METRIC_SYNC_IN_FLIGHT,
      help: 'Store syncs this replica is running right now.',
    });

    this.lastSuccess = this.metrics.gauge({
      name: METRIC_SYNC_LAST_SUCCESS,
      help: 'When a store last synced successfully, in seconds since the '
        + 'epoch. Its age is what staleness is alerted on.',
      labelNames: [
        'store',
      ],
    });

    this.items = this.metrics.counter({
      name: METRIC_SYNC_ITEMS,
      help: 'Offers a sync wrote, by kind: added, updated, removed or seen.',
      labelNames: [
        'store',
        'kind',
      ],
    });

    this.pages = this.metrics.counter({
      name: METRIC_SCRAPE_PAGES,
      help: 'Listing pages walked.',
      labelNames: [
        'store',
      ],
    });

    this.detailPages = this.metrics.counter({
      name: METRIC_SCRAPE_DETAIL_PAGES,
      help: 'Product detail pages fetched, by outcome.',
      labelNames: [
        'store',
        'outcome',
      ],
    });

    this.listingIncomplete = this.metrics.counter({
      name: METRIC_SCRAPE_LISTING_INCOMPLETE,
      help: 'Walks that could not prove they reached the end of the listing, '
        + 'by the stop that ended them. Such a run skips the sweep.',
      labelNames: [
        'store',
        'stop',
      ],
    });

    this.stockDrop = this.metrics.counter({
      name: METRIC_SCRAPE_STOCK_DROP,
      help: 'Runs whose in-stock count fell far enough to be worth a look.',
      labelNames: [
        'store',
      ],
    });

    this.deadlineSkips = this.metrics.counter({
      name: METRIC_SCRAPE_DEADLINE_SKIPS,
      help: 'Items an optional pass skipped because the run was out of '
        + 'budget, by pass. Their fields stay empty until a backfill.',
      labelNames: [
        'store',
        'pass',
      ],
    });
  }

  /**
   * Records that a run has taken its lock and started.
   */
  public runStarted(): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.inFlight.inc();
  }

  /**
   * Records a finished run and, when it succeeded, stamps the store's
   * freshness gauge.
   *
   * @param store - The store's slug.
   * @param trigger - What started the run, manual or cron.
   * @param outcome - success, failed or timeout.
   * @param elapsedMs - How long the run took.
   */
  public runFinished(
    store: string,
    trigger: string,
    outcome: string,
    elapsedMs: number,
  ): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.inFlight.dec();
    this.runs.inc({ store, trigger, outcome });
    this.duration.observe({ store }, elapsedMs / MS_PER_SEC);

    if (outcome === 'success') {
      this.lastSuccess.set({ store }, Date.now() / MS_PER_SEC);
    }
  }

  /**
   * Stamps when a store last synced successfully, for a value read from the
   * database rather than observed by this replica.
   *
   * @param store - The store's slug.
   * @param at - When it last succeeded.
   */
  public setLastSuccess(store: string, at: Date): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.lastSuccess.set({ store }, at.getTime() / MS_PER_SEC);
  }

  /**
   * Records what a run persisted.
   *
   * @param store - The store's slug.
   * @param kind - added, updated, removed or seen.
   * @param count - How many.
   */
  public itemsWritten(store: string, kind: string, count: number): void {
    if (!this.metrics.enabled || count <= 0) {
      return;
    }

    this.items.inc({ store, kind }, count);
  }

  /**
   * Records one listing page walked.
   *
   * @param store - The store's slug.
   */
  public pageWalked(store: string): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.pages.inc({ store });
  }

  /**
   * Records detail pages fetched.
   *
   * @param store - The store's slug.
   * @param outcome - fetched or failed.
   * @param count - How many.
   */
  public detailFetched(store: string, outcome: string, count = 1): void {
    if (!this.metrics.enabled || count <= 0) {
      return;
    }

    this.detailPages.inc({ store, outcome }, count);
  }

  /**
   * Records a walk that could not prove it reached the end of the listing.
   *
   * @param store - The store's slug.
   * @param stop - Why the walk stopped.
   */
  public listingIncompleted(store: string, stop: string): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.listingIncomplete.inc({ store, stop });
  }

  /**
   * Records a run whose in-stock count fell far enough to be worth a look.
   *
   * @param store - The store's slug.
   */
  public stockDropped(store: string): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.stockDrop.inc({ store });
  }

  /**
   * Records items an optional pass skipped for want of budget.
   *
   * @param store - The store's slug.
   * @param pass - Which pass gave up: detail, fields, names or flavors.
   * @param count - How many items it left.
   */
  public deadlineSkipped(store: string, pass: string, count: number): void {
    if (!this.metrics.enabled || count <= 0) {
      return;
    }

    this.deadlineSkips.inc({ store, pass }, count);
  }
}
