import { MigrationInterface, QueryRunner } from 'typeorm';

export class AlcomagStore1786370393119 implements MigrationInterface {
  name = 'AlcomagStore1786370393119';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * Alcomag joins as a tier-1 HTTP store: the Bitrix site is fully
     * server-rendered and answers plain requests, so no browser and no
     * impersonation are needed. Delays follow the other independent shops
     * with detail pages (okwine, winewine, wine-point).
     */
    await queryRunner.query(`
      INSERT INTO "store" ("active", "slug", "name", "baseUrl", "color")
      VALUES (true, 'alcomag', 'Алкомаг', 'https://alcomag.ua', '#761e19')
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
      WHERE "slug" = 'alcomag'
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
      WHERE "slug" = 'alcomag'
    `);
  }
}
