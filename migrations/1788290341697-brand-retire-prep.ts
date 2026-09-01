import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Apostrophes deleted before a brand string is keyed, matching
 * `KbKeyUtils.key`. Kept in step with the identical constant in
 * `ProducerRepository`, which normalizes the same way for the research queue.
 */
const APOSTROPHES = "'`’´";

/**
 * Prepares the retirement of the `brand` table.
 *
 * Everything reversible happens here; the two migrations after it recompute
 * the match keys and then drop the table. Splitting them keeps each one
 * readable and lets the regroup run against a `brandOrig` column that is
 * already populated.
 *
 * Three changes, each answering a different question the drop raises.
 *
 * **Where does the research queue get its input?** `product.brandOrig` — the
 * brand string a shop stated, backfilled here from the `brand` row the
 * bottling points at. It is the one thing the knowledge base does not record:
 * a resolved maker is already in `producerId`, so the column carries
 * information only where nothing resolved, which is exactly the queue
 * `/producer/unresolved` and `pnpm research-brands` work through. It is never
 * a label and never a filter.
 *
 * **What happens to the brand blacklists?** They become producer blacklists.
 * The five stored rows all resolve, and two of them — `Chivas` and
 * `Chivas Regal` — resolve to the *same* producer and collapse into one,
 * which is the defect this whole change exists to remove: one user had to hide
 * a maker twice and still missed the eight bottlings filed under
 * `Chivas Brothers`. The insert is `ON CONFLICT DO NOTHING` for that reason,
 * and the pass **fails closed** if any blacklisted brand resolves to nothing:
 * silently dropping somebody's rule would hand them back a catalogue they had
 * deliberately narrowed.
 *
 * **What happens to the logged brand disagreements?** They are deleted.
 * `product_fact_conflict.storedValue` holds a `brand` id as text, so a row
 * with `attribute = 'brand'` points at a table that is about to stop
 * existing. Nothing is lost that matters: the question those rows asked — two
 * shops disagree about who makes this — is now answered by the knowledge base
 * itself, and a bottling it cannot place is listed by `/producer/unresolved`.
 *
 * `down()` reverses all three structurally. The `brandOrig` values and the
 * deleted conflict rows are not restored, and cannot be: the first are copied
 * from a table `down()` does not rebuild, and the second were pointers into
 * it.
 */
export class BrandRetirePrep1788290341697 implements MigrationInterface {
  public name = 'BrandRetirePrep1788290341697';

  /**
   * @param queryRunner - The query runner.
   * @returns Resolves once the column, the table and the moved rules exist.
   * @throws {Error} When a blacklisted brand resolves to no producer.
   */
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "product"
      ADD "brandOrig" character varying(256)
    `);

    await queryRunner.query(`
      UPDATE "product" p
      SET "brandOrig" = b.name
      FROM "brand" b
      WHERE b.id = p."brandId"
    `);

    await queryRunner.query(`
      CREATE TABLE "blacklist_producer" (
          "userId" uuid NOT NULL,
          "producerId" uuid NOT NULL,
          "createdAt" TIMESTAMP NOT NULL DEFAULT now(),

          CONSTRAINT "PK_blacklist_producer"
              PRIMARY KEY ("userId", "producerId"),
          CONSTRAINT "fk_blacklist_producer_user"
              FOREIGN KEY ("userId")
              REFERENCES "user"("id")
              ON DELETE CASCADE
              ON UPDATE CASCADE,
          CONSTRAINT "fk_blacklist_producer_producer"
              FOREIGN KEY ("producerId")
              REFERENCES "producer"("id")
              ON DELETE CASCADE
              ON UPDATE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "blacklist_producer_user_idx" ON "blacklist_producer" (
          "userId"
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "blacklist_producer_producer_idx" ON "blacklist_producer" (
          "producerId"
      )
    `);

    await this.moveBlacklists(queryRunner);

    await queryRunner.query(`
      DELETE FROM "product_fact_conflict" WHERE attribute = 'brand'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX "public"."blacklist_producer_producer_idx"
    `);
    await queryRunner.query(`
      DROP INDEX "public"."blacklist_producer_user_idx"
    `);
    await queryRunner.query('DROP TABLE "blacklist_producer"');
    await queryRunner.query('ALTER TABLE "product" DROP COLUMN "brandOrig"');
  }

  /**
   * Rewrites every brand blacklist rule as a producer rule.
   *
   * The brand name is keyed the way `KbKeyUtils.key` keys it and looked up in
   * `producer_alias`, which is the same path a scrape takes — so a rule
   * naming a spelling the catalogue carried resolves to the maker the
   * knowledge base curated, whatever that spelling was.
   *
   * @param queryRunner - The migration's query runner.
   * @returns Resolves once every rule has moved.
   * @throws {Error} Naming the brands that resolved to nothing.
   */
  private async moveBlacklists(queryRunner: QueryRunner): Promise<void> {
    const orphans = await queryRunner.query(
      `SELECT DISTINCT b.name
       FROM "blacklist_brand" bb
       JOIN "brand" b ON b.id = bb."brandId"
       WHERE NOT EXISTS (
         SELECT 1 FROM "producer_alias" a
         WHERE a.key = btrim(regexp_replace(
           lower(translate(b.name, $1, '')),
           '[^0-9a-zа-яіїєґ]+', ' ', 'g'))
       )`,
      [APOSTROPHES],
    ) as { name: string }[];

    if (orphans.length) {
      throw new Error(
        'Brand retirement aborted: blacklisted brands resolve to no '
          + `producer: ${orphans.map((row) => row.name).join(', ')}`,
      );
    }

    await queryRunner.query(
      `INSERT INTO "blacklist_producer" ("userId", "producerId", "createdAt")
       SELECT bb."userId", a."producerId", min(bb."createdAt")
       FROM "blacklist_brand" bb
       JOIN "brand" b ON b.id = bb."brandId"
       JOIN "producer_alias" a
         ON a.key = btrim(regexp_replace(
           lower(translate(b.name, $1, '')),
           '[^0-9a-zа-яіїєґ]+', ' ', 'g'))
       GROUP BY bb."userId", a."producerId"
       ON CONFLICT DO NOTHING`,
      [APOSTROPHES],
    );
  }
}
