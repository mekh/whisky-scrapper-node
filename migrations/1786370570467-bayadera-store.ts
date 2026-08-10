import { MigrationInterface, QueryRunner } from 'typeorm';

export class BayaderaStore1786370570467 implements MigrationInterface {
  name = 'BayaderaStore1786370570467';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * Bayadera joins as a tier-1 HTTP store: the site is fully
     * server-rendered and answers plain requests, with every listing card
     * carrying the item as JSON in a data attribute.
     */
    await queryRunner.query(`
      INSERT INTO "store" ("active", "slug", "name", "baseUrl", "color")
      VALUES (true, 'bayadera', 'Bayadera', 'https://bayadera.ua', '#d22747')
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
      WHERE "slug" = 'bayadera'
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
      WHERE "slug" = 'bayadera'
    `);
  }
}
