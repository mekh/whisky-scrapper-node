import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import { ID, PriceHistoryPoint, PriceSnapshotUpsertInput } from '~types';

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
}
