import { MigrationInterface, QueryRunner } from 'typeorm';

export class SilpoStore1786301549188 implements MigrationInterface {
  name = 'SilpoStore1786301549188';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * Silpo joins as a tier-1 HTTP store: its catalog JSON API host
     * (sf-ecom-api.silpo.ua) answers plain requests, so no browser is
     * needed despite the Cloudflare Turnstile on the HTML site.
     */
    await queryRunner.query(`
      INSERT INTO "store" ("active", "slug", "name", "baseUrl", "color")
      VALUES (true, 'silpo', 'Сільпо', 'https://silpo.ua', '#ff5c00')
    `);
    await queryRunner.query(`
      INSERT INTO "store_config" (
        "storeId",
        "needsBrowser",
        "tier",
        "delayFrom",
        "delayTo",
        "engine"
      )
      SELECT "id", false, 1, 4, 8, 'ts'
      FROM "store"
      WHERE "slug" = 'silpo'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /**
     * "fk_product_store" cascades, so this also removes every product (and,
     * through "fk_snapshot_product", every price snapshot) the store has
     * accumulated — reverting the seed means un-onboarding the store.
     */
    await queryRunner.query(`
      DELETE FROM "store"
      WHERE "slug" = 'silpo'
    `);
  }
}
