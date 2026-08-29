import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The QA log for "different sources of truth give different data".
 *
 * The canonical write fills only what is still null, so whenever a store's
 * listing disagrees with what the catalogue already holds, that claim is
 * simply dropped — and with it the only evidence that two sources disagreed at
 * all. This table keeps the dropped claim, so the disagreement can be reviewed
 * and, aggregated per store, the unreliable source can be named.
 *
 * It has to be written during the scrape: `rawAttrs` is never persisted, so no
 * later script can reconstruct what a listing said.
 *
 * One row per (product, store, attribute), with `seenCount` bumped on each
 * sighting rather than a row per day — a disagreement that stands for months
 * must not grow the table daily.
 *
 * Only `type`, `country`, `brand` and `abv` are ever compared. `age` and
 * `volumeMl` are components of the frozen match key, so a store stating a
 * different one is describing a **different bottling** — a merge question, not
 * a fact conflict — and logging them would bury the real findings under
 * hundreds of structural false positives.
 */
export class ProductFactConflict1787850600000 implements MigrationInterface {
  public name = 'ProductFactConflict1787850600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "product_fact_conflict" (
          "productId" uuid NOT NULL,
          "storeId" uuid NOT NULL,
          "seenCount" integer NOT NULL DEFAULT '1',
          "attribute" character varying(16) NOT NULL,
          "storedValue" character varying(128),
          "claimedValue" character varying(128),
          "storedSource" character varying(16),
          "resolvedAt" TIMESTAMP,
          "firstSeenAt" TIMESTAMP NOT NULL DEFAULT now(),
          "lastSeenAt" TIMESTAMP NOT NULL DEFAULT now(),

          CONSTRAINT "PK_10ba49a88bc1c6c8227b8feab02"
              PRIMARY KEY ("productId", "storeId", "attribute"),
          CONSTRAINT "fk_product_fact_conflict_product"
              FOREIGN KEY ("productId")
              REFERENCES "product"("id")
              ON DELETE CASCADE
              ON UPDATE CASCADE,
          CONSTRAINT "fk_product_fact_conflict_store"
              FOREIGN KEY ("storeId")
              REFERENCES "store"("id")
              ON DELETE CASCADE
              ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "product_fact_conflict_attribute_idx"
        ON "product_fact_conflict" (
          "attribute"
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "product_fact_conflict_store_idx"
        ON "product_fact_conflict" (
          "storeId"
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE "product_fact_conflict"
    `);
  }
}
