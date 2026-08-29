import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the curated knowledge base — the single source of truth the
 * catalogue was missing — and links `product` to it.
 *
 * The problem this answers is not one bad flavor tag. Every fact about a
 * bottling arrived from whichever store or model spoke first, so the same
 * whisky carried different countries, types and flavors depending on which
 * listing was scraped first, and nothing recorded which claim to believe. A
 * shop is not an authority on what a distillery makes, and neither is a model
 * asked to recall it; both are evidence. These four tables state the facts.
 *
 * `producer` holds distilleries, named brands, blends and independent
 * bottlers in one table because they share aliases, citations and review, and
 * because a name inside a product title does not announce which kind it is.
 * Rows are reached through `producer_alias`, never through `product.brandId`:
 * the catalogue's brand names carry typos (`Isiay Mist`), duplicate spellings
 * (`Macallan` beside `The Macallan`) and secret labels (`An Orkney`, which is
 * Highland Park), and all of them must resolve to one researched entry.
 *
 * `parentId` is what fixes the reported bug: `Ledaig` is a heavily peated
 * brand of the unpeated Tobermory distillery, and modelling it as its own row
 * with a parent — rather than as one distillery with a blurred profile — is
 * what stops a resolver from ever giving Tobermory its sibling's smoke.
 */
export class KbSchema1787850500000 implements MigrationInterface {
  public name = 'KbSchema1787850500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "producer" (
          "id" uuid NOT NULL DEFAULT uuidv7(),
          "countryId" uuid,
          "parentId" uuid,
          "bottlerId" uuid,
          "slug" character varying(64) NOT NULL,
          "name" character varying(128) NOT NULL,
          "kind" character varying(16) NOT NULL,
          "region" character varying(16),
          "legalRegion" character varying(16),
          "owner" character varying(128),
          "defaultTypeName" character varying(64),
          "peatProfile" character varying(16) NOT NULL DEFAULT 'unknown',
          "status" character varying(16) NOT NULL DEFAULT 'unverified',
          "confidence" character varying(16),
          "sourceUrls" text,
          "note" text,
          "verifiedAt" TIMESTAMP,
          "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

          CONSTRAINT "PK_4cfe496c2c70e4c9b9f444525a6" PRIMARY KEY ("id"),
          CONSTRAINT "producer_legal_region_check"
              CHECK ("legalRegion" <> 'islands'),
          CONSTRAINT "fk_producer_country"
              FOREIGN KEY ("countryId")
              REFERENCES "country"("id")
              ON DELETE SET NULL
              ON UPDATE NO ACTION,
          CONSTRAINT "fk_producer_parent"
              FOREIGN KEY ("parentId")
              REFERENCES "producer"("id")
              ON DELETE SET NULL
              ON UPDATE NO ACTION,
          CONSTRAINT "fk_producer_bottler"
              FOREIGN KEY ("bottlerId")
              REFERENCES "producer"("id")
              ON DELETE SET NULL
              ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "producer_slug_uindex" ON "producer" (
          "slug"
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "producer_region_idx" ON "producer" (
          "region"
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "producer_status_idx" ON "producer" (
          "status"
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "producer_alias" (
          "id" uuid NOT NULL DEFAULT uuidv7(),
          "producerId" uuid NOT NULL,
          "key" character varying(128) NOT NULL,
          "scope" character varying(16) NOT NULL DEFAULT 'any',
          "note" text,
          "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

          CONSTRAINT "PK_0b124b0f71746714d7c4831d82e" PRIMARY KEY ("id"),
          CONSTRAINT "fk_producer_alias_producer"
              FOREIGN KEY ("producerId")
              REFERENCES "producer"("id")
              ON DELETE CASCADE
              ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "producer_alias_key_uindex" ON "producer_alias" (
          "key"
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "producer_alias_producer_idx" ON "producer_alias" (
          "producerId"
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "producer_flavor" (
          "producerId" uuid NOT NULL,
          "flavorId" uuid NOT NULL,
          "effect" character varying(16) NOT NULL,
          "confidence" character varying(16),
          "sourceUrls" text,
          "note" text,
          "createdAt" TIMESTAMP NOT NULL DEFAULT now(),

          CONSTRAINT "PK_eac221b96af0e144971469f6b50"
              PRIMARY KEY ("producerId", "flavorId"),
          CONSTRAINT "fk_producer_flavor_producer"
              FOREIGN KEY ("producerId")
              REFERENCES "producer"("id")
              ON DELETE CASCADE
              ON UPDATE CASCADE,
          CONSTRAINT "fk_producer_flavor_flavor"
              FOREIGN KEY ("flavorId")
              REFERENCES "flavor"("id")
              ON DELETE CASCADE
              ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_844e97b6d76bd9178e62ef2dbc" ON "producer_flavor" (
          "producerId"
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_4ceb6243f88280a089a4cd990b" ON "producer_flavor" (
          "flavorId"
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "flavor_rule" (
          "id" uuid NOT NULL DEFAULT uuidv7(),
          "producerId" uuid,
          "flavorId" uuid,
          "priority" integer NOT NULL DEFAULT '0',
          "pattern" character varying(64) NOT NULL,
          "matchMode" character varying(16) NOT NULL DEFAULT 'word',
          "effect" character varying(16),
          "peatProfile" character varying(16),
          "sourceUrls" text,
          "note" text,
          "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

          CONSTRAINT "PK_bc96bc4cdd0684a2b09e03ebdd1" PRIMARY KEY ("id"),
          CONSTRAINT "flavor_rule_kind_check"
              CHECK (
                ("flavorId" IS NOT NULL AND "effect" IS NOT NULL
                  AND "peatProfile" IS NULL)
                OR ("flavorId" IS NULL AND "effect" IS NULL
                  AND "peatProfile" IS NOT NULL)
              ),
          CONSTRAINT "fk_flavor_rule_producer"
              FOREIGN KEY ("producerId")
              REFERENCES "producer"("id")
              ON DELETE CASCADE
              ON UPDATE NO ACTION,
          CONSTRAINT "fk_flavor_rule_flavor"
              FOREIGN KEY ("flavorId")
              REFERENCES "flavor"("id")
              ON DELETE CASCADE
              ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "flavor_rule_uindex" ON "flavor_rule" (
          "producerId",
          "pattern",
          "flavorId"
      ) NULLS NOT DISTINCT
    `);
    await queryRunner.query(`
      CREATE INDEX "flavor_rule_producer_idx" ON "flavor_rule" (
          "producerId"
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "product"
        ADD "producerId" uuid,
        ADD "bottlerId" uuid,
        ADD CONSTRAINT "fk_product_producer"
            FOREIGN KEY ("producerId")
            REFERENCES "producer"("id")
            ON DELETE SET NULL
            ON UPDATE NO ACTION,
        ADD CONSTRAINT "fk_product_bottler"
            FOREIGN KEY ("bottlerId")
            REFERENCES "producer"("id")
            ON DELETE SET NULL
            ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      CREATE INDEX "product_producer_idx" ON "product" (
          "producerId"
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "product_bottler_idx" ON "product" (
          "bottlerId"
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX "public"."product_bottler_idx"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."product_producer_idx"
    `);
    await queryRunner.query(`
      ALTER TABLE "product"
        DROP CONSTRAINT "fk_product_bottler",
        DROP CONSTRAINT "fk_product_producer",
        DROP COLUMN "bottlerId",
        DROP COLUMN "producerId"
    `);
    await queryRunner.query(`
      DROP TABLE "flavor_rule"
    `);
    await queryRunner.query(`
      DROP TABLE "producer_flavor"
    `);
    await queryRunner.query(`
      DROP TABLE "producer_alias"
    `);
    await queryRunner.query(`
      DROP TABLE "producer"
    `);
  }
}
