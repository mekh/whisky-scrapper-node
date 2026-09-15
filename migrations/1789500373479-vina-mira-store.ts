import { MigrationInterface, QueryRunner } from 'typeorm';

export class VinaMiraStore1789500373479 implements MigrationInterface {
  name = 'VinaMiraStore1789500373479';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * Best Wine (vina-mira.com.ua) joins as a tier-1 HTTP store: an OpenCart
     * shop, fully server-rendered behind plain nginx with no Cloudflare, so
     * plain fetch works. Its whisky category is one flat listing of ~294
     * bottlings that prints its own item count, which the walk reconciles
     * against instead of trusting an empty page — the site sits behind a page
     * cache, where a blank page reads exactly like the end of the catalogue.
     *
     * The shop's promotions page (`/specials/?fcid=90`) is deliberately not
     * scraped: its 88 whiskies are a subset of this category and carry the
     * same strike-through markup, and walking the promotions alone would flag
     * a bottling out of stock the day it left the sale while the shop still
     * sold it.
     *
     * Operational note: the first fill must run through
     * `pnpm backfill --store vina-mira`. Type and country live on the product
     * pages, so the first run would chase most of the 294 of them at the
     * politeness delay and blow the store sync timeout, persisting nothing.
     * Every later sync fetches details only for SKUs new to the store whose
     * bottling the catalogue is still missing something about.
     */
    await queryRunner.query(`
      INSERT INTO "store" ("active", "slug", "name", "baseUrl", "color")
      VALUES (
        true,
        'vina-mira',
        'Best Wine',
        'https://vina-mira.com.ua',
        '#00897b'
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
      WHERE "slug" = 'vina-mira'
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
      WHERE "slug" = 'vina-mira'
    `);
  }
}
