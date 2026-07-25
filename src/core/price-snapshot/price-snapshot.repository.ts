import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';
import { ID, PriceSnapshotUpsertInput } from '~types';

import { PriceSnapshotEntity } from './price-snapshot.entity';

@TypeormRepository(PriceSnapshotEntity)
export class PriceSnapshotRepository
  extends BaseRepository<PriceSnapshotEntity> {
  /**
   * Writes a product's snapshot for a given capture day: inserts it, or
   * overwrites the existing row for that `(productId, capturedOn)` so there is
   * always exactly one row per product per day (last write wins). Atomic via
   * the unique index — safe against concurrent same-day syncs.
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
    await this.query(
      `INSERT INTO price_snapshot
         ("productId", "capturedOn", price, "oldPrice", currency, "inStock",
          promo)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ("productId", "capturedOn") DO UPDATE SET
         price = EXCLUDED.price,
         "oldPrice" = EXCLUDED."oldPrice",
         currency = EXCLUDED.currency,
         "inStock" = EXCLUDED."inStock",
         promo = EXCLUDED.promo,
         "updatedAt" = now()`,
      [
        productId,
        capturedOn,
        data.price,
        data.oldPrice,
        data.currency,
        data.inStock,
        data.promo,
      ],
    );
  }
}
