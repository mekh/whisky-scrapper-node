import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives every fact field on `product` a provenance column, and marks every
 * value that predates them as `legacy`.
 *
 * Until now a stored fact carried no record of where it came from, and the
 * canonical write was fill-if-null — so whichever store or model spoke first
 * owned the value forever. That is what made the catalogue uncorrectable: a
 * guess made on the day a bottling was discovered outranked a distillery's own
 * spec page, and a hand-typed correction was indistinguishable from that guess
 * and could be overwritten by the next pass.
 *
 * The backfill is a blanket `legacy` rather than an inferred source, and that
 * is deliberate. `legacy` states the truth — the provenance is unknown —
 * whereas inferring would be a lie: the catalogue holds rows whose age an
 * early scraper read out of a description ("понад 250 років" recorded as an
 * age), so even "age always comes from the name" does not hold historically.
 * The shrinking share of `legacy` is the coverage metric for the knowledge-base
 * work that follows.
 */
export class ProductFactProvenance1787850400000 implements MigrationInterface {
  public name = 'ProductFactProvenance1787850400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "product"
        ADD "nameSource" character varying(16),
        ADD "typeSource" character varying(16),
        ADD "countrySource" character varying(16),
        ADD "brandSource" character varying(16),
        ADD "abvSource" character varying(16),
        ADD "ageSource" character varying(16),
        ADD "volumeSource" character varying(16),
        ADD "producerSource" character varying(16)
    `);
    await queryRunner.query(`
      UPDATE "product" SET
        "nameSource" = CASE WHEN "name" IS NOT NULL THEN 'legacy' END,
        "typeSource" = CASE WHEN "typeId" IS NOT NULL THEN 'legacy' END,
        "countrySource" = CASE WHEN "countryId" IS NOT NULL THEN 'legacy' END,
        "brandSource" = CASE WHEN "brandId" IS NOT NULL THEN 'legacy' END,
        "abvSource" = CASE WHEN "abv" IS NOT NULL THEN 'legacy' END,
        "ageSource" = CASE WHEN "age" IS NOT NULL THEN 'legacy' END,
        "volumeSource" = CASE WHEN "volumeMl" IS NOT NULL THEN 'legacy' END
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "product"
        DROP COLUMN "producerSource",
        DROP COLUMN "volumeSource",
        DROP COLUMN "ageSource",
        DROP COLUMN "abvSource",
        DROP COLUMN "brandSource",
        DROP COLUMN "countrySource",
        DROP COLUMN "typeSource",
        DROP COLUMN "nameSource"
    `);
  }
}
