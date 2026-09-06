import { MigrationInterface, QueryRunner } from 'typeorm';

export class UserCollection1788712477687 implements MigrationInterface {
  name = 'UserCollection1788712477687';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "user_collection" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "userId" uuid NOT NULL,
                "productId" uuid NOT NULL,
                "rating" numeric(3, 1),
                "barcode" character varying(32),
                "notes" text,
                "nose" text,
                "palate" text,
                "finish" text,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

                CONSTRAINT "PK_a15a3843f63bb1c1a9711826739" PRIMARY KEY ("id"),
                CONSTRAINT "user_collection_rating_check" CHECK (
                    "rating" IS NULL
                    OR (
                        "rating" >= 0
                        AND "rating" <= 10
                    )
                ),
                CONSTRAINT "user_collection_barcode_check" CHECK (
                    "barcode" IS NULL
                    OR "barcode" ~ '^[0-9]{8,14}$'
                ),
                CONSTRAINT "fk_user_collection_user"
                    FOREIGN KEY ("userId")
                    REFERENCES "user"("id")
                    ON DELETE CASCADE
                    ON UPDATE CASCADE,
                CONSTRAINT "fk_user_collection_product"
                    FOREIGN KEY ("productId")
                    REFERENCES "product"("id")
                    ON DELETE RESTRICT
                    ON UPDATE NO ACTION
            )
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "user_collection_user_product_uindex" ON "user_collection" (
                "userId",
                "productId"
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "user_collection_purchase" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "collectionId" uuid NOT NULL,
                "storeId" uuid,
                "storeProductId" uuid,
                "price" numeric(12, 2),
                "storeName" character varying(128),
                "purchasedOn" date NOT NULL DEFAULT ('now'::text)::date,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

                CONSTRAINT "PK_100d6fbfe8edd7422760f243c40" PRIMARY KEY ("id"),
                CONSTRAINT "user_collection_purchase_price_check" CHECK (
                    "price" IS NULL
                    OR "price" >= 0
                ),
                CONSTRAINT "user_collection_purchase_store_check" CHECK (
                    num_nonnulls("storeId", "storeName") <= 1
                ),
                CONSTRAINT "fk_user_collection_purchase_collection"
                    FOREIGN KEY ("collectionId")
                    REFERENCES "user_collection"("id")
                    ON DELETE CASCADE
                    ON UPDATE CASCADE,
                CONSTRAINT "fk_user_collection_purchase_store"
                    FOREIGN KEY ("storeId")
                    REFERENCES "store"("id")
                    ON DELETE SET NULL
                    ON UPDATE NO ACTION,
                CONSTRAINT "fk_user_collection_purchase_offer"
                    FOREIGN KEY ("storeProductId")
                    REFERENCES "store_product"("id")
                    ON DELETE SET NULL
                    ON UPDATE NO ACTION
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "user_collection_purchase_collection_idx" ON "user_collection_purchase" (
                "collectionId",
                "purchasedOn"
            )
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP INDEX "public"."user_collection_purchase_collection_idx"
        `);
    await queryRunner.query(`
            DROP TABLE "user_collection_purchase"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."user_collection_user_product_uindex"
        `);
    await queryRunner.query(`
            DROP TABLE "user_collection"
        `);
  }
}
