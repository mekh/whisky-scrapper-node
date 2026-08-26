import { MigrationInterface, QueryRunner } from 'typeorm';

export class WinebutikStore1787742426440 implements MigrationInterface {
  name = 'WinebutikStore1787742426440';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * Винний Бутик joins as a tier-1 HTTP store: a Drupal Commerce site,
     * fully server-rendered behind plain nginx (no Cloudflare), so plain
     * fetch works. Its listing sorts purchasable items strictly ahead of a
     * sold-out tail, which is what lets the walk stop at the tail's first
     * page instead of draining ~35 pages of unbuyable items.
     *
     * Operational note: the first fill must run through
     * `pnpm backfill --store winebutik`. The catalog is ~550 purchasable
     * SKUs, heavy on collector bottlings the catalogue does not cover, so
     * the first run would chase most detail pages at the politeness delay
     * and blow the store sync timeout, persisting nothing. Every later sync
     * only fetches details for new SKUs and fits the budget.
     */
    await queryRunner.query(`
      INSERT INTO "store" ("active", "slug", "name", "baseUrl", "color")
      VALUES (
        true,
        'winebutik',
        'Винний Бутик',
        'https://winebutik.com.ua',
        '#ff9647'
      )
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
      WHERE "slug" = 'winebutik'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /**
     * "fk_product_store" cascades, so this also removes every offer (and,
     * through "fk_snapshot_product", every price snapshot) the store has
     * accumulated — reverting the seed means un-onboarding the store.
     */
    await queryRunner.query(`
      DELETE FROM "store"
      WHERE "slug" = 'winebutik'
    `);
  }
}
