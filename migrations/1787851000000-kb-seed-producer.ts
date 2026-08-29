import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Data file sitting next to this migration. `nest-cli.json` copies
 * `migrations/**\/*.tsv` into `dist/migrations`, so `__dirname` resolves it
 * both under ts-node (dev) and in the compiled production image.
 */
const TSV_FILE = '1787851000000-kb-seed-producer.tsv';

/**
 * Fields per line, in file order.
 */
const FIELDS = 15;

/**
 * Seeds the curated producers — the catalogue's first authority on what a
 * whisky actually is.
 *
 * Everything before this migration made the schema able to hold facts; this is
 * the migration that puts facts in it. Until it runs, `product.producerId` is
 * null everywhere and the resolver has nothing to match against, which is why
 * the reported bug (`Tobermory 12` tagged smoky) survives the schema work and
 * dies here.
 *
 * The import is **fail-closed**. A country code, whisky type or peat level the
 * database does not recognise aborts the whole migration rather than importing
 * a row with a silently-null column: a producer that resolves but states the
 * wrong country is worse than one that does not resolve at all, because the
 * first is trusted.
 *
 * Self-references (`parentId`, `bottlerId`) are resolved in a second pass, for
 * the ordinary reason that a row cannot point at a sibling that does not exist
 * yet — and the seed is deliberately not topologically sorted, because the
 * ordering would then be a hidden precondition nobody maintains.
 */
export class KbSeedProducer1787851000000 implements MigrationInterface {
  public name = 'KbSeedProducer1787851000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows = this.read();

    if (!rows.length) {
      throw new Error(`${TSV_FILE} holds no producers`);
    }

    await this.assertCountries(queryRunner, rows);
    await this.assertTypes(queryRunner, rows);

    await queryRunner.query(
      `INSERT INTO producer
         (slug, name, kind, "countryId", region, "legalRegion", owner,
          "defaultTypeName", "peatProfile", status, confidence, "sourceUrls",
          note)
       SELECT v.slug, v.name, v.kind, c.id,
              nullif(v.region, ''), nullif(v."legalRegion", ''),
              nullif(v.owner, ''), nullif(v."defaultTypeName", ''),
              v."peatProfile", v.status,
              nullif(v.confidence, ''), nullif(v."sourceUrls", ''),
              nullif(v.note, '')
       FROM unnest(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
         $6::text[], $7::text[], $8::text[], $9::text[], $10::text[],
         $11::text[], $12::text[], $13::text[]
       ) AS v(slug, name, kind, "countryCode", region, "legalRegion", owner,
              "defaultTypeName", "peatProfile", status, confidence,
              "sourceUrls", note)
       LEFT JOIN country c ON c.code = nullif(v."countryCode", '')
       ON CONFLICT (slug) DO NOTHING`,
      [
        rows.map((row) => row[0]),
        rows.map((row) => row[1]),
        rows.map((row) => row[2]),
        rows.map((row) => row[3]),
        rows.map((row) => row[4]),
        rows.map((row) => row[5]),
        rows.map((row) => row[6]),
        rows.map((row) => row[7]),
        rows.map((row) => row[8]),
        rows.map((row) => row[11]),
        rows.map((row) => row[12]),
        rows.map((row) => row[13]),
        rows.map((row) => row[14]),
      ],
    );

    await this.linkReferences(queryRunner, rows);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const slugs = this.read().map((row) => row[0]);

    await queryRunner.query(
      'DELETE FROM producer WHERE slug = ANY($1::text[])',
      [slugs],
    );
  }

  /**
   * Parses the seed file.
   *
   * A line without exactly {@link FIELDS} fields means a value contained a tab
   * and every field after it has shifted, so the migration fails rather than
   * importing a row whose columns no longer mean what they say.
   *
   * @returns One field array per producer.
   * @throws {Error} When the file is missing or a line is malformed.
   */
  private read(): string[][] {
    const text = readFileSync(join(__dirname, TSV_FILE), 'utf8');
    const rows: string[][] = [];

    text.split('\n').forEach((line, index) => {
      if (!line.trim()) {
        return;
      }

      const parts = line.split('\t');

      if (parts.length !== FIELDS) {
        throw new Error(
          `${TSV_FILE}:${index + 1} has ${parts.length} fields, `
            + `expected ${FIELDS}`,
        );
      }

      rows.push(parts);
    });

    return rows;
  }

  /**
   * Fails the migration when a producer names a country the database has no
   * row for.
   *
   * @param queryRunner - The running migration's query runner.
   * @param rows - The parsed producers.
   * @returns Resolves when every code is known.
   * @throws {Error} Naming the unknown codes.
   */
  private async assertCountries(
    queryRunner: QueryRunner,
    rows: string[][],
  ): Promise<void> {
    const codes = [...new Set(rows.map((row) => row[3]).filter(Boolean))];

    if (!codes.length) {
      return;
    }

    const found = await queryRunner.query(
      'SELECT code FROM country WHERE code = ANY($1::text[])',
      [codes],
    ) as { code: string }[];

    const known = new Set(found.map((row) => row.code));
    const missing = codes.filter((code) => !known.has(code));

    if (missing.length) {
      throw new Error(
        `${TSV_FILE}: unknown country codes ${missing.join(',')}`,
      );
    }
  }

  /**
   * Fails the migration when a producer names a whisky type the database has
   * no row for. The column stores the name rather than an id, so an unknown
   * value would sit there looking valid and never match anything.
   *
   * @param queryRunner - The running migration's query runner.
   * @param rows - The parsed producers.
   * @returns Resolves when every type name is known.
   * @throws {Error} Naming the unknown types.
   */
  private async assertTypes(
    queryRunner: QueryRunner,
    rows: string[][],
  ): Promise<void> {
    const names = [...new Set(rows.map((row) => row[7]).filter(Boolean))];

    if (!names.length) {
      return;
    }

    const found = await queryRunner.query(
      'SELECT name FROM type WHERE name = ANY($1::text[])',
      [names],
    ) as { name: string }[];

    const known = new Set(found.map((row) => row.name));
    const missing = names.filter((name) => !known.has(name));

    if (missing.length) {
      throw new Error(`${TSV_FILE}: unknown whisky types ${missing.join(',')}`);
    }
  }

  /**
   * Resolves `parentSlug` and `bottlerSlug` to ids, now that every row exists.
   *
   * A reference to a slug that is not in the file is dropped rather than
   * raising: the merge step already reported it, and a dangling parent costs a
   * sibling arbitration, not a wrong fact.
   *
   * @param queryRunner - The running migration's query runner.
   * @param rows - The parsed producers.
   * @returns Resolves once the references are linked.
   */
  private async linkReferences(
    queryRunner: QueryRunner,
    rows: string[][],
  ): Promise<void> {
    const linked = rows.filter((row) => row[9] || row[10]);

    if (!linked.length) {
      return;
    }

    await queryRunner.query(
      `UPDATE producer p SET
         "parentId" = parent.id,
         "bottlerId" = bottler.id
       FROM unnest($1::text[], $2::text[], $3::text[])
         AS v(slug, "parentSlug", "bottlerSlug")
       LEFT JOIN producer parent ON parent.slug = nullif(v."parentSlug", '')
       LEFT JOIN producer bottler ON bottler.slug = nullif(v."bottlerSlug", '')
       WHERE p.slug = v.slug`,
      [
        linked.map((row) => row[0]),
        linked.map((row) => row[9]),
        linked.map((row) => row[10]),
      ],
    );
  }
}
