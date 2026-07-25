import { MigrationInterface, QueryRunner } from 'typeorm';

export class PriceSnapshotCapturedOn1784966976966
  implements MigrationInterface {
  name = 'PriceSnapshotCapturedOn1784966976966';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Default is written as ('now'::text)::date, not CURRENT_DATE: it is the
    // form TypeORM's postgres driver normalizes the entity's () => 'CURRENT_DATE'
    // default to, so migration:generate reports no drift. Both evaluate to
    // today's date, and the default must stay on the column so the legacy
    // Python collector — which inserts without listing capturedOn — keeps
    // working during the transition.
    await queryRunner.query(`
      ALTER TABLE "price_snapshot"
      ADD "capturedOn" date NOT NULL DEFAULT ('now'::text)::date
    `);

    // Collapse any pre-existing same-day duplicates — the old app-only
    // "one row per day" convention had no constraint to prevent them. Keep the
    // newest row per product per day; it carries the most current price/stock.
    // Runs before the backfill and unique index below (order is load-bearing).
    await queryRunner.query(`
      DELETE FROM "price_snapshot"
      WHERE "id" IN (
          SELECT "id"
          FROM (
              SELECT "id",
                     ROW_NUMBER() OVER (
                         PARTITION BY "productId", "createdAt"::date
                         ORDER BY "createdAt" DESC, "id" DESC
                     ) AS rn
              FROM "price_snapshot"
          ) ranked
          WHERE ranked.rn > 1
      )
    `);

    // The column default filled every existing row with today; set each to its
    // real capture day instead, matching the createdAt::date basis the report
    // queries already use.
    await queryRunner.query(`
      UPDATE "price_snapshot"
      SET "capturedOn" = "createdAt"::date
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "price_snapshot_product_captured_uindex" ON "price_snapshot" (
          "productId",
          "capturedOn"
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX "public"."price_snapshot_product_captured_uindex"
    `);
    await queryRunner.query(`
      ALTER TABLE "price_snapshot" DROP COLUMN "capturedOn"
    `);
  }
}
