import { MigrationInterface, QueryRunner } from 'typeorm';

export class FlavorLlmSource1786348257025 implements MigrationInterface {
  name = 'FlavorLlmSource1786348257025';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * Every existing link was produced by the keyword pass during a sync, so
     * the default backfills them correctly. From here on `setFlavors` replaces
     * only `scrape` rows, which is what lets the LLM pass write links that
     * survive later syncs.
     */
    await queryRunner.query(`
      ALTER TABLE "product_flavor"
      ADD "source" character varying(16) NOT NULL DEFAULT 'scrape'
    `);

    /**
     * Null means the LLM flavor pass has never answered for this product. It
     * stays null on a failed batch, so a re-run retries those items.
     */
    await queryRunner.query(`
      ALTER TABLE "product"
      ADD "lastLlmFlavorAt" TIMESTAMP
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "product" DROP COLUMN "lastLlmFlavorAt"
    `);

    await queryRunner.query(`
      ALTER TABLE "product_flavor" DROP COLUMN "source"
    `);
  }
}
