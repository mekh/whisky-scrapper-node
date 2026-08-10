import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The closed flavor vocabulary, mirroring `FLAVOR_TAGS`
 * (`src/scrape/normalize/brand-info.constants.ts`). Inlined rather than
 * imported: a migration is a historical record and must keep applying the same
 * change after the constant moves on. It is also the importer's last line of
 * defence — a tag the classifier invented is dropped here rather than polluting
 * the lookup table.
 */
const KEEP = new Set([
  'peated',
  'smoky',
  'sherry',
  'bourbon-cask',
  'vanilla',
  'honey',
  'fruity',
  'chocolate',
  'spicy',
  'floral',
  'citrus',
  'nutty',
  'caramel',
  'oak',
  'maritime',
]);

/**
 * Data file sitting next to this migration. `nest-cli.json` copies
 * `migrations/**\/*.csv` into `dist/migrations`, so `__dirname` resolves it both
 * under ts-node (dev) and in the compiled production image.
 */
const CSV_FILE = '1786350000000-flavor-llm-import.csv';

/**
 * One classified product name.
 */
interface FlavorRow {
  /**
   * The cleaned product name (`product.name`), used as the join key.
   */
  name: string;

  /**
   * Allowlisted tags for that name; empty when the classifier did not recognize
   * the product.
   */
  tags: string[];
}

export class FlavorLlmImport1786350000000 implements MigrationInterface {
  name = 'FlavorLlmImport1786350000000';

  /**
   * Parses the CSV shipped beside this migration.
   *
   * The format is deliberately trivial — `name,confidence,tags` with
   * pipe-separated tags — because no product name in the catalogue contains a
   * comma or a quote, so there is nothing to escape and no need for a real CSV
   * reader. A line that does not have exactly three fields means that
   * assumption broke, and the migration fails rather than importing a
   * mis-split name that would silently match no product.
   *
   * @returns One entry per classified name, tags filtered to the vocabulary.
   * @throws {Error} When the file is missing or a line is malformed.
   */
  private static parse(): FlavorRow[] {
    const path = join(__dirname, CSV_FILE);

    let text: string;

    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw new Error(
        `Cannot read ${CSV_FILE} next to the migration (${path}). `
          + 'It ships as a nest-cli asset; check that the build copied it. '
          + `Cause: ${(error as Error).message}`,
      );
    }

    const lines = text
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '');

    if (lines[0]?.startsWith('name,')) {
      lines.shift();
    }

    return lines.map((line, index) => {
      const fields = line.split(',');

      if (fields.length !== 3) {
        throw new Error(
          `${CSV_FILE} line ${index + 2}: expected 3 fields, got `
            + `${fields.length} — ${line}`,
        );
      }

      const tags = fields[2]
        .split('|')
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => KEEP.has(tag));

      return { name: fields[0], tags: [...new Set(tags)] };
    });
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * Flavor tags classified per **distinct product name** rather than per
     * product row: the same bottling is listed by many stores, so 2 059 names
     * cover all ~7 000 rows. Every matching row gets the links, which is what
     * makes the report's flavor filter behave consistently across stores.
     *
     * Written as `source = 'llm'` so the sync's `setFlavors` — which deletes
     * and reinserts only its own `scrape` rows — cannot wipe them. A tag the
     * keyword pass already found is taken over rather than duplicated.
     */
    const rows = FlavorLlmImport1786350000000.parse();

    const names = rows.map((row) => row.name);

    const pairNames: string[] = [];
    const pairTags: string[] = [];

    rows.forEach((row) => {
      row.tags.forEach((tag) => {
        pairNames.push(row.name);
        pairTags.push(tag);
      });
    });

    await queryRunner.query(
      `INSERT INTO "flavor" ("name")
       SELECT DISTINCT t FROM unnest($1::text[]) AS t
       ON CONFLICT ("name") DO NOTHING`,
      [pairTags],
    );

    await queryRunner.query(
      `INSERT INTO "product_flavor" ("productId", "flavorId", "source")
       SELECT p."id", f."id", 'llm'
       FROM unnest($1::text[], $2::text[]) AS v("name", "tag")
       JOIN "product" p ON p."name" = v."name"
       JOIN "flavor" f ON f."name" = v."tag"
       ON CONFLICT ("productId", "flavorId") DO UPDATE SET "source" = 'llm'`,
      [pairNames, pairTags],
    );

    /**
     * Stamped for every classified name, including the ones the classifier
     * could not place. An unrecognized product links no flavor, so without the
     * stamp it is indistinguishable from one that was never asked about, and
     * `pnpm enrich-flavors` would keep re-sending it to the model forever.
     */
    await queryRunner.query(
      `UPDATE "product" SET "lastLlmFlavorAt" = now()
       WHERE "name" = ANY($1::text[])`,
      [names],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    /**
     * Scoped to the names this migration classified, so an LLM answer written
     * later by the runtime pass for some other product survives. Within those
     * names it cannot distinguish this import from a later re-classification —
     * both are `source = 'llm'` — so a revert clears both and leaves the
     * products to be classified again.
     *
     * It also drops the keyword-derived links `up()` **promoted**: a tag both
     * passes found ends up as one row owned by `llm`, and nothing records that
     * it used to be `scrape`, so it is deleted here rather than demoted. On a
     * dev revert that took `scrape` links from 6 735 to 2 919. They are not
     * lost — the keyword pass re-derives its own links on the next sync of each
     * store — but the catalogue is under-tagged until that runs.
     */
    const names = FlavorLlmImport1786350000000.parse().map((row) => row.name);

    await queryRunner.query(
      `DELETE FROM "product_flavor"
       WHERE "source" = 'llm'
         AND "productId" IN (
           SELECT "id" FROM "product" WHERE "name" = ANY($1::text[])
         )`,
      [names],
    );

    await queryRunner.query(
      `UPDATE "product" SET "lastLlmFlavorAt" = NULL
       WHERE "name" = ANY($1::text[])`,
      [names],
    );
  }
}
