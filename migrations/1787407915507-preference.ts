import { MigrationInterface, QueryRunner } from 'typeorm';

export class Preference1787407915507 implements MigrationInterface {
  name = 'Preference1787407915507';

  public async up(queryRunner: QueryRunner): Promise<void> {
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
      CREATE TABLE "blacklist_product" (
          "userId" uuid NOT NULL,
          "productId" uuid NOT NULL,
          "createdAt" TIMESTAMP NOT NULL DEFAULT now(),

          CONSTRAINT "PK_c4451302a0bdc137da0f44fa5bd"
              PRIMARY KEY ("userId", "productId"),
          CONSTRAINT "fk_blacklist_product_user"
              FOREIGN KEY ("userId")
              REFERENCES "user"("id")
              ON DELETE CASCADE
              ON UPDATE CASCADE,
          CONSTRAINT "fk_blacklist_product_product"
              FOREIGN KEY ("productId")
              REFERENCES "product"("id")
              ON DELETE CASCADE
              ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "blacklist_product_user_idx" ON "blacklist_product" (
          "userId"
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "blacklist_product_product_idx" ON "blacklist_product" (
          "productId"
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "favorite" (
          "userId" uuid NOT NULL,
          "productId" uuid NOT NULL,
          "createdAt" TIMESTAMP NOT NULL DEFAULT now(),

          CONSTRAINT "PK_f0e7bf803aa937033d10dc07ed4"
              PRIMARY KEY ("userId", "productId"),
          CONSTRAINT "fk_favorite_user"
              FOREIGN KEY ("userId")
              REFERENCES "user"("id")
              ON DELETE CASCADE
              ON UPDATE CASCADE,
          CONSTRAINT "fk_favorite_product"
              FOREIGN KEY ("productId")
              REFERENCES "product"("id")
              ON DELETE CASCADE
              ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "favorite_user_idx" ON "favorite" (
          "userId"
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "favorite_product_idx" ON "favorite" (
          "productId"
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX "public"."favorite_product_idx"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."favorite_user_idx"
    `);
    await queryRunner.query(`
      DROP TABLE "favorite"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."blacklist_product_product_idx"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."blacklist_product_user_idx"
    `);
    await queryRunner.query(`
      DROP TABLE "blacklist_product"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."blacklist_brand_brand_idx"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."blacklist_brand_user_idx"
    `);
    await queryRunner.query(`
      DROP TABLE "blacklist_brand"
    `);
  }
}
