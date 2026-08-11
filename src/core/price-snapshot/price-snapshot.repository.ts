import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';
import { ID, PriceHistoryPoint, PriceSnapshotUpsertInput } from '~types';

import { PriceSnapshotEntity } from './price-snapshot.entity';

@TypeormRepository(PriceSnapshotEntity)
export class PriceSnapshotRepository
  extends BaseRepository<PriceSnapshotEntity> {
  /**
   * Writes one store offer's snapshot for a given capture day: inserts it, or
   * overwrites the existing row for that `(storeProductId, capturedOn)` so
   * there is always exactly one row per offer per day (last write wins). Atomic
   * via the unique index — safe against concurrent same-day syncs.
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
    await this.query(
      `INSERT INTO price_snapshot
         ("storeProductId", "capturedOn", price, "oldPrice", currency,
          "inStock", promo)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ("storeProductId", "capturedOn") DO UPDATE SET
         price = EXCLUDED.price,
         "oldPrice" = EXCLUDED."oldPrice",
         currency = EXCLUDED.currency,
         "inStock" = EXCLUDED."inStock",
         promo = EXCLUDED.promo,
         "updatedAt" = now()`,
      [
        storeProductId,
        capturedOn,
        data.price,
        data.oldPrice,
        data.currency,
        data.inStock,
        data.promo,
      ],
    );
  }

  /**
   * Returns the most recent snapshot capture date across all offers.
   *
   * @returns The latest date (`YYYY-MM-DD`), or null when there are none.
   */
  public async latestDate(): Promise<string | null> {
    const rows = await this.query(
      'SELECT MAX("createdAt"::date)::text AS d FROM price_snapshot',
    ) as { d: string | null }[];

    return rows[0]?.d ?? null;
  }

  /**
   * Computes the min and max price per store offer over snapshots on/after a
   * cutoff date.
   *
   * @param cutoff - Inclusive lower bound date (`YYYY-MM-DD`).
   * @returns Map from store-offer id to its `{ min, max }` over the window.
   */
  public async priceExtremes(
    cutoff: string,
  ): Promise<Map<ID, { min: number; max: number }>> {
    const rows = await this.query(
      `SELECT "storeProductId",
              MIN(price)::float8 AS min, MAX(price)::float8 AS max
       FROM price_snapshot
       WHERE "createdAt"::date >= $1
       GROUP BY "storeProductId"`,
      [cutoff],
    ) as { storeProductId: ID; min: number; max: number }[];

    return new Map(rows.map((row) => [row.storeProductId, {
      min: row.min,
      max: row.max,
    }]));
  }

  /**
   * For every store offer, the date since which its price has not been higher
   * than its current (latest) price — i.e. when the current price level took
   * hold. It is the capture date of the first snapshot after the most recent
   * one priced above the current price; when the price was never higher, the
   * offer's very first snapshot. Ages the `drops` report's current discount.
   *
   * @returns Map from store-offer id to that date (`YYYY-MM-DD`).
   */
  public async currentPriceSince(): Promise<Map<ID, string>> {
    const rows = await this.query(
      `WITH latest AS (
         SELECT DISTINCT ON ("storeProductId")
                "storeProductId", price AS "currentPrice"
         FROM price_snapshot
         ORDER BY "storeProductId", "createdAt" DESC
       ),
       last_higher AS (
         SELECT s."storeProductId", MAX(s."createdAt") AS "higherAt"
         FROM price_snapshot s
         JOIN latest l ON l."storeProductId" = s."storeProductId"
         WHERE s.price > l."currentPrice"
         GROUP BY s."storeProductId"
       )
       SELECT s."storeProductId", MIN(s."createdAt")::date::text AS since
       FROM price_snapshot s
       LEFT JOIN last_higher h ON h."storeProductId" = s."storeProductId"
       WHERE h."higherAt" IS NULL OR s."createdAt" > h."higherAt"
       GROUP BY s."storeProductId"`,
    ) as { storeProductId: ID; since: string }[];

    return new Map(rows.map((row) => [row.storeProductId, row.since]));
  }

  /**
   * Loads one store offer's price history, oldest point first. The series is
   * deliberately per offer: a price history belongs to the store that set it,
   * and merging several stores' into one line would describe nothing real.
   *
   * @param storeProductId - Store-offer id.
   * @param limit - Maximum number of most-recent points to return.
   * @returns Chronological price points.
   */
  public async priceSeries(
    storeProductId: ID,
    limit: number,
  ): Promise<PriceHistoryPoint[]> {
    const rows = await this.query(
      `SELECT "createdAt"::date::text AS date, price::float8 AS price
       FROM price_snapshot
       WHERE "storeProductId" = $1
       ORDER BY "createdAt" DESC
       LIMIT $2`,
      [storeProductId, limit],
    ) as PriceHistoryPoint[];

    return rows.reverse();
  }
}
