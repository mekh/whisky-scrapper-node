import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import {
  DashboardBreakdownRow,
  DashboardCaptureBounds,
  DashboardDailyCountryRow,
  DashboardDailyRow,
  DashboardDailyStoreRow,
  DashboardMover,
  DashboardStoreCoverage,
  ID,
  PriceHistoryPoint,
  PriceSnapshotUpsertInput,
} from '~types';

import { PriceSnapshotEntity } from './price-snapshot.entity';
import { PriceSnapshotRepository } from './price-snapshot.repository';

/**
 * Persistence-layer public API for the `price_snapshot` entity. Every id in
 * this service's signatures is a **store-offer** id: a price belongs to the
 * store that quoted it, not to the bottling.
 */
@Injectable()
export class CorePriceSnapshotService
  extends CoreBaseService<PriceSnapshotEntity> {
  public constructor(protected readonly repo: PriceSnapshotRepository) {
    super(repo);
  }

  /**
   * Writes one offer's snapshot for a capture day (one row per offer per day,
   * last write wins).
   *
   * @param storeProductId - Store offer the snapshot belongs to.
   * @param capturedOn - Capture day (`YYYY-MM-DD`).
   * @param data - The snapshot's price fields.
   * @returns Resolves once the row is written.
   */
  public async upsertForDate(
    storeProductId: ID,
    capturedOn: string,
    data: PriceSnapshotUpsertInput,
  ): Promise<void> {
    return this.repo.upsertForDate(storeProductId, capturedOn, data);
  }

  /**
   * Returns the most recent snapshot capture date across all offers.
   *
   * @returns The latest date (`YYYY-MM-DD`), or null when there are none.
   */
  public async latestDate(): Promise<string | null> {
    return this.repo.latestDate();
  }

  /**
   * Computes the min and max price per offer over a window.
   *
   * @param cutoff - Inclusive lower bound date (`YYYY-MM-DD`).
   * @returns Map from store-offer id to its `{ min, max }` over the window.
   */
  public async priceExtremes(
    cutoff: string,
  ): Promise<Map<ID, { min: number; max: number }>> {
    return this.repo.priceExtremes(cutoff);
  }

  /**
   * For every offer, the date since which its price has not been higher.
   *
   * @returns Map from store-offer id to that date (`YYYY-MM-DD`).
   */
  public async currentPriceSince(): Promise<Map<ID, string>> {
    return this.repo.currentPriceSince();
  }

  /**
   * Loads one offer's price history, oldest point first.
   *
   * @param storeProductId - Store-offer id.
   * @param limit - Maximum number of most-recent points to return.
   * @returns Chronological price points.
   */
  public async priceSeries(
    storeProductId: ID,
    limit: number,
  ): Promise<PriceHistoryPoint[]> {
    return this.repo.priceSeries(storeProductId, limit);
  }

  /**
   * The snapshot table's overall capture bounds — the dashboard data floor.
   *
   * @returns The bounds; both dates null on an empty table.
   */
  public async captureBounds(): Promise<DashboardCaptureBounds> {
    return this.repo.captureBounds();
  }

  /**
   * Per-store snapshot coverage and listing counts.
   *
   * @returns One row per store, ordered by store name.
   */
  public async coverage(): Promise<DashboardStoreCoverage[]> {
    return this.repo.coverage();
  }

  /**
   * Daily snapshot aggregates over a range.
   *
   * @param from - Inclusive range start (`YYYY-MM-DD`).
   * @param to - Inclusive range end (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @returns One row per day with data, ascending by date.
   */
  public async dailyMetrics(
    from: string,
    to: string,
    stores: string[] | null,
  ): Promise<DashboardDailyRow[]> {
    return this.repo.dailyMetrics(from, to, stores);
  }

  /**
   * Daily snapshot aggregates partitioned by store.
   *
   * @param from - Inclusive range start (`YYYY-MM-DD`).
   * @param to - Inclusive range end (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @returns One row per (day, store) with data.
   */
  public async dailyMetricsByStore(
    from: string,
    to: string,
    stores: string[] | null,
  ): Promise<DashboardDailyStoreRow[]> {
    return this.repo.dailyMetricsByStore(from, to, stores);
  }

  /**
   * Daily snapshot aggregates partitioned by the bottling's country.
   *
   * @param from - Inclusive range start (`YYYY-MM-DD`).
   * @param to - Inclusive range end (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @returns One row per (day, country) with data.
   */
  public async dailyMetricsByCountry(
    from: string,
    to: string,
    stores: string[] | null,
  ): Promise<DashboardDailyCountryRow[]> {
    return this.repo.dailyMetricsByCountry(from, to, stores);
  }

  /**
   * Snapshot aggregates for the first and last day with data in a range.
   *
   * @param from - Inclusive range start (`YYYY-MM-DD`).
   * @param to - Inclusive range end (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @returns Zero, one or two rows, ascending by date.
   */
  public async boundaryMetrics(
    from: string,
    to: string,
    stores: string[] | null,
  ): Promise<DashboardDailyRow[]> {
    return this.repo.boundaryMetrics(from, to, stores);
  }

  /**
   * Listing and distinct-bottling totals for one capture day.
   *
   * @param date - Capture day (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @returns The day's totals; zeros when the day has no data.
   */
  public async totalsForDate(
    date: string,
    stores: string[] | null,
  ): Promise<{ listings: number; products: number }> {
    return this.repo.totalsForDate(date, stores);
  }

  /**
   * One capture day's assortment sliced by whisky type.
   *
   * @param date - Capture day (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @returns One row per type, largest listing count first.
   */
  public async breakdownByType(
    date: string,
    stores: string[] | null,
  ): Promise<DashboardBreakdownRow[]> {
    return this.repo.breakdownByType(date, stores);
  }

  /**
   * One capture day's assortment sliced by country.
   *
   * @param date - Capture day (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @returns One row per country code, largest listing count first.
   */
  public async breakdownByCountry(
    date: string,
    stores: string[] | null,
  ): Promise<DashboardBreakdownRow[]> {
    return this.repo.breakdownByCountry(date, stores);
  }

  /**
   * One capture day's assortment sliced by store.
   *
   * @param date - Capture day (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @returns One row per store slug, largest listing count first.
   */
  public async breakdownByStore(
    date: string,
    stores: string[] | null,
  ): Promise<DashboardBreakdownRow[]> {
    return this.repo.breakdownByStore(date, stores);
  }

  /**
   * One capture day's assortment sliced by flavor tag (overlapping buckets).
   *
   * @param date - Capture day (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @returns One row per flavor, largest listing count first.
   */
  public async breakdownByFlavor(
    date: string,
    stores: string[] | null,
  ): Promise<DashboardBreakdownRow[]> {
    return this.repo.breakdownByFlavor(date, stores);
  }

  /**
   * One capture day's assortment sliced into price buckets.
   *
   * @param date - Capture day (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @param boundaries - Ascending inner bucket boundaries (UAH).
   * @returns One row per non-empty bucket, ascending by ordinal.
   */
  public async breakdownByPriceBucket(
    date: string,
    stores: string[] | null,
    boundaries: number[],
  ): Promise<DashboardBreakdownRow[]> {
    return this.repo.breakdownByPriceBucket(date, stores, boundaries);
  }

  /**
   * Top price movers over a range, per direction.
   *
   * @param from - Inclusive range start (`YYYY-MM-DD`).
   * @param to - Inclusive range end (`YYYY-MM-DD`).
   * @param stores - Store slugs to scope to, or null for all stores.
   * @param limit - Rows to return.
   * @param minPrice - Minimum starting price, or null for no floor.
   * @param direction - `asc` for the biggest drops, `desc` for rises.
   * @returns The top movers for the direction.
   */
  public async priceEdges(
    from: string,
    to: string,
    stores: string[] | null,
    limit: number,
    minPrice: number | null,
    direction: 'asc' | 'desc',
  ): Promise<DashboardMover[]> {
    return this.repo.priceEdges(from, to, stores, limit, minPrice, direction);
  }
}
