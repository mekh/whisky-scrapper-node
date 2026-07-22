import { MigrationInterface, QueryRunner } from 'typeorm';

export class WhiskyDomain1783840751031 implements MigrationInterface {
  name = 'WhiskyDomain1783840751031';

  public async up(queryRunner: QueryRunner): Promise<void> {
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
            CREATE TABLE "country" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "code" character varying(8) NOT NULL,
                "nameUa" character varying(64) NOT NULL,
                "icon" character varying(32),
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

                CONSTRAINT "PK_bf6e37c231c4f4ea56dcd887269" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "country_code_uindex" ON "country" (
                "code"
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "flavor" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "name" character varying(64) NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

                CONSTRAINT "PK_934fe79b3d8131395c29a040ee5" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "flavor_name_uindex" ON "flavor" (
                "name"
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "type" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "name" character varying(64) NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

                CONSTRAINT "PK_40410d6bf0bedb43f9cadae6fef" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "type_name_uindex" ON "type" (
                "name"
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "store" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "active" boolean NOT NULL DEFAULT true,
                "slug" character varying(64) NOT NULL,
                "name" character varying(128) NOT NULL,
                "baseUrl" character varying(512) NOT NULL,
                "color" character varying(16),
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

                CONSTRAINT "PK_f3172007d4de5ae8e7692759d79" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "store_slug_uindex" ON "store" (
                "slug"
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "store_config" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "storeId" uuid NOT NULL,
                "needsBrowser" boolean NOT NULL DEFAULT false,
                "tier" integer NOT NULL,
                "delayFrom" real NOT NULL,
                "delayTo" real NOT NULL,
                "retailChain" character varying(64),
                "category" character varying(64),
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

                CONSTRAINT "PK_5c595867ae59a54fc907c570700" PRIMARY KEY ("id"),
                CONSTRAINT "fk_store_config_store"
                    FOREIGN KEY ("storeId")
                    REFERENCES "store"("id")
                    ON DELETE CASCADE
                    ON UPDATE NO ACTION
            )
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "store_config_store_uindex" ON "store_config" (
                "storeId"
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "product" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "storeId" uuid NOT NULL,
                "brandId" uuid,
                "typeId" uuid,
                "countryId" uuid,
                "age" integer,
                "abv" real,
                "volumeMl" integer,
                "sku" character varying(128) NOT NULL,
                "url" character varying(1024) NOT NULL,
                "name" character varying(512),
                "nameOrig" character varying(512) NOT NULL,
                "firstSeen" date NOT NULL,
                "lastSeen" date NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

                CONSTRAINT "PK_bebc9158e480b949565b4dc7a82" PRIMARY KEY ("id"),
                CONSTRAINT "fk_product_store"
                    FOREIGN KEY ("storeId")
                    REFERENCES "store"("id")
                    ON DELETE CASCADE
                    ON UPDATE NO ACTION,
                CONSTRAINT "fk_product_brand"
                    FOREIGN KEY ("brandId")
                    REFERENCES "brand"("id")
                    ON DELETE SET NULL
                    ON UPDATE NO ACTION,
                CONSTRAINT "fk_product_type"
                    FOREIGN KEY ("typeId")
                    REFERENCES "type"("id")
                    ON DELETE SET NULL
                    ON UPDATE NO ACTION,
                CONSTRAINT "fk_product_country"
                    FOREIGN KEY ("countryId")
                    REFERENCES "country"("id")
                    ON DELETE SET NULL
                    ON UPDATE NO ACTION
            )
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "product_store_sku_uindex" ON "product" (
                "storeId",
                "sku"
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "price_snapshot" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "productId" uuid NOT NULL,
                "inStock" boolean NOT NULL DEFAULT true,
                "promo" boolean NOT NULL DEFAULT false,
                "price" numeric(12, 2) NOT NULL,
                "oldPrice" numeric(12, 2),
                "currency" character varying(8) NOT NULL DEFAULT 'UAH',
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

                CONSTRAINT "PK_2cc519fe024a44176db2173d64d" PRIMARY KEY ("id"),
                CONSTRAINT "fk_snapshot_product"
                    FOREIGN KEY ("productId")
                    REFERENCES "product"("id")
                    ON DELETE CASCADE
                    ON UPDATE NO ACTION
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "price_snapshot_product_created_idx" ON "price_snapshot" (
                "productId",
                "createdAt"
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "sync_log" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "storeId" uuid NOT NULL,
                "success" boolean,
                "added" integer NOT NULL DEFAULT '0',
                "removed" integer NOT NULL DEFAULT '0',
                "updated" integer NOT NULL DEFAULT '0',
                "total" integer NOT NULL DEFAULT '0',
                "error" text,
                "finishedAt" TIMESTAMP,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

                CONSTRAINT "PK_5a1c2f181ab99c0757868c7d0fc" PRIMARY KEY ("id"),
                CONSTRAINT "fk_synclog_store"
                    FOREIGN KEY ("storeId")
                    REFERENCES "store"("id")
                    ON DELETE CASCADE
                    ON UPDATE NO ACTION
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "sync_log_store_created_idx" ON "sync_log" (
                "storeId",
                "createdAt"
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "product_flavor" (
                "productId" uuid NOT NULL,
                "flavorId" uuid NOT NULL,

                CONSTRAINT "PK_ea200810628ea0582bfdc101319" PRIMARY KEY ("productId", "flavorId"),
                CONSTRAINT "fk_product_flavor_product"
                    FOREIGN KEY ("productId")
                    REFERENCES "product"("id")
                    ON DELETE CASCADE
                    ON UPDATE CASCADE,
                CONSTRAINT "fk_product_flavor_flavor"
                    FOREIGN KEY ("flavorId")
                    REFERENCES "flavor"("id")
                    ON DELETE CASCADE
                    ON UPDATE CASCADE
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "IDX_ffe61c7eaa57fa5feecf217847" ON "product_flavor" (
                "productId"
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "IDX_22847be61c509121d398c00c22" ON "product_flavor" (
                "flavorId"
            )
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP INDEX "public"."IDX_22847be61c509121d398c00c22"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."IDX_ffe61c7eaa57fa5feecf217847"
        `);
    await queryRunner.query(`
            DROP TABLE "product_flavor"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."sync_log_store_created_idx"
        `);
    await queryRunner.query(`
            DROP TABLE "sync_log"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."price_snapshot_product_created_idx"
        `);
    await queryRunner.query(`
            DROP TABLE "price_snapshot"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."product_store_sku_uindex"
        `);
    await queryRunner.query(`
            DROP TABLE "product"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."store_config_store_uindex"
        `);
    await queryRunner.query(`
            DROP TABLE "store_config"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."store_slug_uindex"
        `);
    await queryRunner.query(`
            DROP TABLE "store"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."type_name_uindex"
        `);
    await queryRunner.query(`
            DROP TABLE "type"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."flavor_name_uindex"
        `);
    await queryRunner.query(`
            DROP TABLE "flavor"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."country_code_uindex"
        `);
    await queryRunner.query(`
            DROP TABLE "country"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."brand_name_uindex"
        `);
    await queryRunner.query(`
            DROP TABLE "brand"
        `);
  }
}
