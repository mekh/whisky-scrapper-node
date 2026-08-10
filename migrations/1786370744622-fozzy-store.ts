import { MigrationInterface, QueryRunner } from 'typeorm';

export class FozzyStore1786370744622 implements MigrationInterface {
  name = 'FozzyStore1786370744622';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * Fozzy Shop joins as a tier-1 HTTP store: the listing is server-rendered
     * and Cloudflare answers plain GET requests, so no browser is needed.
     *
     * Operational note: the first fill must run through
     * `pnpm backfill --store fozzy`. The catalog is ~300 SKUs and every one
     * of them is missing a stored ABV at that point, so a regular sync would
     * chase ~300 detail pages at the store's politeness delay and blow the
     * store sync timeout, persisting nothing. The backfill runs untimed;
     * every later sync only fetches details for new SKUs and fits the budget.
     */
    await queryRunner.query(`
      INSERT INTO "store" ("active", "slug", "name", "baseUrl", "color")
      VALUES (true, 'fozzy', 'Fozzy Shop', 'https://fozzyshop.ua', '#e40428')
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
      WHERE "slug" = 'fozzy'
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
      WHERE "slug" = 'fozzy'
    `);
  }
}
