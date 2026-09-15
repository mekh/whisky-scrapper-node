import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives `product` the new-product review queue: a status and the moment a
 * person last decided it.
 *
 * A sync mints a bottling from whatever a shop printed, and nothing ever put
 * that row in front of a human. So a truncated name, an age read out of prose
 * or a bag of drink ice a shop files under whisky sat in the catalogue until
 * somebody happened to trip over it. `reviewStatus` is the work queue that
 * fixes that, and `rejected` is what finally makes "this is not whisky" a
 * button instead of a `DELETE` nobody dares run (see `CURATION.md`).
 *
 * **The two `ALTER`s are the mechanism, not a stylistic split.** `ADD COLUMN
 * ... DEFAULT 'pending'` in one step would give the default to the rows
 * already there as well — every bottling in the catalogue would land in the
 * queue on deploy, which is a separate decision with its own window (see the
 * enqueue script). Adding the column without a default leaves those rows
 * `NULL`, and setting the default afterwards affects only inserts that omit
 * the column — which is all three of them, and any future one. Both steps are
 * catalogue-wide metadata changes, so neither rewrites a row.
 *
 * That default is therefore the **only** writer of this column on the scrape
 * path, deliberately: the three insert sites would otherwise each need the
 * column in their own list, and a fourth one added later would silently not
 * enrol its rows — a bottling that never reaches the queue is invisible by
 * construction, which is the failure mode the queue exists to remove.
 *
 * `NULL` means "never entered the workflow" and is the state every pre-existing
 * row keeps. The consequence to hold on to: a predicate over this column must
 * use `IS DISTINCT FROM`, since `NULL <> 'rejected'` is `NULL` and would hide
 * the whole catalogue that predates the queue.
 *
 * No `reviewedBy`: `producer` records only *when* a row was verified and not
 * by whom, there is exactly one reviewer today, and a foreign key to `user`
 * would have to be carried through `ProductRepository.mergeInto` and seeded by
 * every fixture of this feature.
 *
 * Purely additive and structurally reversible, so `ROLLBACK.md`'s PATH A can
 * leave it applied.
 */
export class ProductReviewStatus1789400000000 implements MigrationInterface {
  public name = 'ProductReviewStatus1789400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "product"
        ADD "reviewStatus" character varying(16),
        ADD "reviewedAt" TIMESTAMP
    `);
    await queryRunner.query(`
      ALTER TABLE "product"
      ALTER COLUMN "reviewStatus" SET DEFAULT 'pending'
    `);
    await queryRunner.query(`
      CREATE INDEX "product_review_status_idx" ON "product" (
          "reviewStatus"
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX "public"."product_review_status_idx"
    `);
    await queryRunner.query(`
      ALTER TABLE "product"
        DROP COLUMN "reviewedAt",
        DROP COLUMN "reviewStatus"
    `);
  }
}
