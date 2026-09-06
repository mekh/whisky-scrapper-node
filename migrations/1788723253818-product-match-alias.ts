import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `product_match_alias`: the retired match keys that still resolve to
 * a bottling.
 *
 * A match key is frozen when a bottling is created and never re-derived, so
 * when two rows turn out to be one whisky and are merged, the vanishing row
 * takes its key with it — and that key is exactly what the next listing
 * spelled the same way derives again. Before this table existed, the very
 * duplicate a merge had just folded away was recreated by the next sync that
 * met such a listing. The find-or-create step of every persist now consults
 * this table ahead of `product.matchKey`, so a retired key lands on the
 * survivor. A row keeps its own key on `product`; this table holds the others
 * it answers for. The rows are written only by a merge (the runtime one in
 * `ProductRepository.mergeInto` and the data migration that follows this
 * one), never by a scrape.
 *
 * `ON DELETE CASCADE` is deliberate and the opposite of what the offers get:
 * an alias is a pointer with no history of its own, so when its bottling goes
 * the pointer goes too rather than blocking the delete.
 */
export class ProductMatchAlias1788723253818 implements MigrationInterface {
  public name = 'ProductMatchAlias1788723253818';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "product_match_alias" (
                "key" character varying(1024) NOT NULL,
                "productId" uuid NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),

                CONSTRAINT "PK_fe07e97b1a0089920c2dd60933b" PRIMARY KEY ("key"),
                CONSTRAINT "fk_product_match_alias_product"
                    FOREIGN KEY ("productId")
                    REFERENCES "product"("id")
                    ON DELETE CASCADE
                    ON UPDATE CASCADE
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "product_match_alias_product_idx" ON "product_match_alias" (
                "productId"
            )
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP INDEX "public"."product_match_alias_product_idx"
        `);
    await queryRunner.query(`
            DROP TABLE "product_match_alias"
        `);
  }
}
