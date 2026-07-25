import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import { ID, PriceSnapshotUpsertInput } from '~types';

import { PriceSnapshotEntity } from './price-snapshot.entity';
import { PriceSnapshotRepository } from './price-snapshot.repository';

/**
 * Persistence-layer public API for the `price_snapshot` entity.
 */
@Injectable()
export class CorePriceSnapshotService
  extends CoreBaseService<PriceSnapshotEntity> {
  public constructor(protected readonly repo: PriceSnapshotRepository) {
    super(repo);
  }

  /**
   * Writes a product's snapshot for a capture day (one row per product per
   * day, last write wins).
   *
   * @param productId - Product the snapshot belongs to.
   * @param capturedOn - Capture day (`YYYY-MM-DD`).
   * @param data - The snapshot's price fields.
   * @returns Resolves once the row is written.
   */
  public async upsertForDate(
    productId: ID,
    capturedOn: string,
    data: PriceSnapshotUpsertInput,
  ): Promise<void> {
    return this.repo.upsertForDate(productId, capturedOn, data);
  }
}
