import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops the `brand` table and everything that pointed at it.
 *
 * The catalogue's brand column was never curated: `ScrapePersistService` minted
 * a row from whatever string a shop printed, through an
 * `INSERT ... ON CONFLICT (name) DO NOTHING` whose unique index is case- and
 * punctuation-sensitive, so one maker accumulated several rows —
 * `Macallan[104]` beside `The Macallan[20]`, `M H[10]` beside
 * `M&h Elements[4]`, `Chivas Regal[30]` beside `Chivas[13]` beside
 * `Chivas Brothers[8]`. Measured on a production dump, **685 of 709 rows
 * already resolved to a knowledge-base producer**, and the 24 that did not
 * carried two bottlings between them. The table was a second, worse registry
 * of something `producer` and `producer_alias` already hold.
 *
 * So the label moves: a report's `brand` is now
 * `COALESCE(producer.name, bottler.name)`, the blacklist names a producer, and
 * `/brand/search` searches producers through their aliases. The wire contract
 * is unchanged — the field, the parameter and the route keep the word a
 * shopper uses — only what the values mean changes.
 *
 * **18 bottlings lose their label, and that is the correct answer for 17 of
 * them.** They resolve to producers the knowledge base has already `rejected`
 * with a cited note: `Vulson` (a rye eau-de-vie never rested in wood),
 * `Yakusun`, `Undone` (labelled "THIS IS NOT WHISKEY"), `Spice Monkey` (a
 * liqueur), `Marc De Champagne` (a grape brandy), `Boulevardier` (a cocktail),
 * `Bayadera` (a retailer), `Kentucky`, `Moulin`. The eighteenth, `Ice Drive`,
 * is simply unresearched and will be labelled once `pnpm research-brands`
 * reaches it — its shop spelling survives in `product.brandOrig`, which is
 * what puts it in that queue.
 *
 * `down()` rebuilds every structure exactly and repopulates `brand` from
 * `product.brandOrig`, but it is **semantically best-effort**, the same
 * caveat `product-canonical-split` documents about its own: the rebuilt table
 * holds one row per surviving shop spelling rather than the rows that stood
 * here, a bottling whose brand was known only through a deleted row comes back
 * unbranded, and the blacklist rules come back naming producers' own names
 * rather than the spellings a user originally picked.
 */
export class BrandDrop1788290343697 implements MigrationInterface {
  public name = 'BrandDrop1788290343697';

  /**
   * @param queryRunner - The query runner.
   * @returns Resolves once nothing references the `brand` table and it is
   *   gone.
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX "public"."blacklist_brand_brand_idx"',
    );
    await queryRunner.query('DROP INDEX "public"."blacklist_brand_user_idx"');
    await queryRunner.query('DROP TABLE "blacklist_brand"');

    await queryRunner.query(`
      ALTER TABLE "product"
      DROP CONSTRAINT "fk_product_brand"
    `);
    await queryRunner.query('ALTER TABLE "product" DROP COLUMN "brandSource"');
    await queryRunner.query('ALTER TABLE "product" DROP COLUMN "brandId"');

    await queryRunner.query('DROP INDEX "public"."brand_name_uindex"');
    await queryRunner.query('DROP TABLE "brand"');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "brand" (
          "id" uuid NOT NULL DEFAULT uuidv7(),
          "name" character varying(256) NOT NULL,
          "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

          CONSTRAINT "PK_a5d20765ddd942eb5de4eee2d7f" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "brand_name_uindex" ON "brand" (
          "name"
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "product"
      ADD "brandId" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "product"
      ADD "brandSource" character varying(16)
    `);

    await queryRunner.query(`
      INSERT INTO "brand" (name)
      SELECT DISTINCT "brandOrig" FROM "product" WHERE "brandOrig" IS NOT NULL
    `);

    await queryRunner.query(`
      UPDATE "product" p
      SET "brandId" = b.id, "brandSource" = 'legacy'
      FROM "brand" b
      WHERE b.name = p."brandOrig"
    `);

    await queryRunner.query(`
      ALTER TABLE "product"
      ADD CONSTRAINT "fk_product_brand"
          FOREIGN KEY ("brandId")
          REFERENCES "brand"("id")
          ON DELETE SET NULL
          ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TABLE "blacklist_brand" (
          "userId" uuid NOT NULL,
          "brandId" uuid NOT NULL,
          "createdAt" TIMESTAMP NOT NULL DEFAULT now(),

          CONSTRAINT "PK_a6408e5d48d41f325eff6d28a5c"
              PRIMARY KEY ("userId", "brandId"),
          CONSTRAINT "fk_blacklist_brand_user"
              FOREIGN KEY ("userId")
              REFERENCES "user"("id")
              ON DELETE CASCADE
              ON UPDATE CASCADE,
          CONSTRAINT "fk_blacklist_brand_brand"
              FOREIGN KEY ("brandId")
              REFERENCES "brand"("id")
              ON DELETE CASCADE
              ON UPDATE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "blacklist_brand_user_idx" ON "blacklist_brand" (
          "userId"
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "blacklist_brand_brand_idx" ON "blacklist_brand" (
          "brandId"
      )
    `);

    await queryRunner.query(`
      INSERT INTO "blacklist_brand" ("userId", "brandId", "createdAt")
      SELECT bp."userId", b.id, bp."createdAt"
      FROM "blacklist_producer" bp
      JOIN "producer" pr ON pr.id = bp."producerId"
      JOIN "brand" b ON b.name = pr.name
      ON CONFLICT DO NOTHING
    `);
  }
}
