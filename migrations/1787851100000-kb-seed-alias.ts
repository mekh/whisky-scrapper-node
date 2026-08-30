import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Data file sitting next to this migration; see the producer seed for why
 * `__dirname` resolves it in both environments.
 */
const TSV_FILE = '1787851100000-kb-seed-alias.tsv';

/**
 * Fields per line: key, producerSlug, scope.
 */
const FIELDS = 3;

/**
 * Shortest alias allowed to be matched inside a product name. Mirrors
 * `KB_NAME_ALIAS_MIN_LENGTH`; inlined because a migration is a historical
 * record and must keep applying the same rule after the constant moves on.
 */
const NAME_SCOPE_MIN_LENGTH = 5;

/**
 * Seeds the spellings that resolve to a producer.
 *
 * This table, not `product.brandId`, is what the resolver matches on — and the
 * reason is visible in the data it has to cope with: the catalogue's brand
 * names include `Isiay Mist` (a capital I read as an l), `Douglas Laingcompany`
 * and `Pear's Beast`, alongside `Macallan` beside `The Macallan` and secret
 * labels like `An Orkney`, which is Highland Park. Every one of those has to
 * reach a single researched row, and a clean external list would leave exactly
 * the damaged ones unresolved.
 *
 * Keys arrive already normalized by `KbKeyUtils.key` — the same function the
 * resolver normalizes product names with — so a spelling that imports is one
 * the resolver will certainly find.
 *
 * Fail-closed on two things: an alias naming a producer that does not exist,
 * and a short alias asking to be matched inside product names. The second is
 * not pedantry — the catalogue holds `Elements of Islay`, `M&H Elements` and
 * `Glenmorangie Elementa`, so a bare `elements` matched as a substring would
 * mis-resolve two of the three.
 */
export class KbSeedAlias1787851100000 implements MigrationInterface {
  public name = 'KbSeedAlias1787851100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows = this.read();

    if (!rows.length) {
      throw new Error(`${TSV_FILE} holds no aliases`);
    }

    await this.assertProducers(queryRunner, rows);

    await queryRunner.query(
      `INSERT INTO producer_alias (key, "producerId", scope)
       SELECT v.key, p.id, v.scope
       FROM unnest($1::text[], $2::text[], $3::text[])
         AS v(key, slug, scope)
       JOIN producer p ON p.slug = v.slug
       ON CONFLICT (key) DO NOTHING`,
      [
        rows.map((row) => row[0]),
        rows.map((row) => row[1]),
        rows.map((row) => row[2]),
      ],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const keys = this.read().map((row) => row[0]);

    await queryRunner.query(
      'DELETE FROM producer_alias WHERE key = ANY($1::text[])',
      [keys],
    );
  }

  /**
   * Parses the seed file, enforcing the shape and the name-scope floor.
   *
   * @returns One field array per alias.
   * @throws {Error} When a line is malformed or a short alias claims a scope
   *   that would let it match inside a product name.
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

      if (parts[2] !== 'brand' && parts[0].length < NAME_SCOPE_MIN_LENGTH) {
        throw new Error(
          `${TSV_FILE}:${index + 1} alias '${parts[0]}' is shorter than `
            + `${NAME_SCOPE_MIN_LENGTH} characters and must be brand-scoped`,
        );
      }

      rows.push(parts);
    });

    return rows;
  }

  /**
   * Fails the migration when an alias names a producer the seed did not
   * create. Such a row would import as nothing and leave a brand silently
   * unresolved, which is the failure mode hardest to notice.
   *
   * @param queryRunner - The running migration's query runner.
   * @param rows - The parsed aliases.
   * @returns Resolves when every slug exists.
   * @throws {Error} Naming the missing producers.
   */
  private async assertProducers(
    queryRunner: QueryRunner,
    rows: string[][],
  ): Promise<void> {
    const slugs = [...new Set(rows.map((row) => row[1]))];

    const found = await queryRunner.query(
      'SELECT slug FROM producer WHERE slug = ANY($1::text[])',
      [slugs],
    ) as { slug: string }[];

    const known = new Set(found.map((row) => row.slug));
    const missing = slugs.filter((slug) => !known.has(slug));

    if (missing.length) {
      throw new Error(`${TSV_FILE}: unknown producers ${missing.join(',')}`);
    }
  }
}
