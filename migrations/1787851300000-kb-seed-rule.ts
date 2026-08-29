import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Data file sitting next to this migration.
 */
const TSV_FILE = '1787851300000-kb-seed-rule.tsv';

/**
 * Fields per line: producerSlug, pattern, matchMode, flavor, effect,
 * peatProfile, priority, sourceUrls, note.
 */
const FIELDS = 9;

/**
 * Seeds the name-pattern rules — what a bottling's own name states about it.
 *
 * These carry the variance a single house profile cannot: Bruichladdich is
 * unpeated and `Port Charlotte` in the name makes a bottling heavy;
 * Bunnahabhain's core range is unpeated and `Mòine` is not; `Benromach
 * Unpeated` says outright the opposite of Benromach's light house style. They
 * are also the reason `PeatProfile` needs no `variable` band — a band that
 * would tell the resolver nothing it could act on.
 *
 * The global rules matter most. They read the name alone, so a peated
 * expression of a producer nobody researched is still caught, and the
 * negations outrank everything so an explicit `unpeated` can never be
 * overridden by a house profile.
 *
 * A row is either a peat rule or a tag rule, never both — the table's CHECK
 * enforces it, and this importer fails first with a line number so the error
 * names the file rather than the constraint.
 */
export class KbSeedRule1787851300000 implements MigrationInterface {
  public name = 'KbSeedRule1787851300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows = this.read();

    if (!rows.length) {
      throw new Error(`${TSV_FILE} holds no rules`);
    }

    await this.assertProducers(queryRunner, rows);
    await this.assertFlavors(queryRunner, rows);

    await queryRunner.query(
      `INSERT INTO flavor_rule
         ("producerId", pattern, "matchMode", "flavorId", effect,
          "peatProfile", priority, "sourceUrls", note)
       SELECT p.id, v.pattern, v."matchMode", f.id,
              nullif(v.effect, ''), nullif(v."peatProfile", ''),
              v.priority::int, nullif(v."sourceUrls", ''), nullif(v.note, '')
       FROM unnest(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
         $6::text[], $7::text[], $8::text[], $9::text[]
       ) AS v(slug, pattern, "matchMode", flavor, effect, "peatProfile",
              priority, "sourceUrls", note)
       LEFT JOIN producer p ON p.slug = nullif(v.slug, '')
       LEFT JOIN flavor f ON f.name = nullif(v.flavor, '')
       ON CONFLICT ("producerId", pattern, "flavorId") DO NOTHING`,
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
      ],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const patterns = [...new Set(this.read().map((row) => row[1]))];

    await queryRunner.query(
      'DELETE FROM flavor_rule WHERE pattern = ANY($1::text[])',
      [patterns],
    );
  }

  /**
   * Parses the seed file and enforces the peat-or-tag split.
   *
   * @returns One field array per rule.
   * @throws {Error} When a line is malformed or states both kinds of rule, or
   *   neither.
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

      const isPeat = Boolean(parts[5]);
      const isTag = Boolean(parts[3]) && Boolean(parts[4]);

      if (isPeat === isTag) {
        throw new Error(
          `${TSV_FILE}:${index + 1} must be either a peat rule or a tag rule, `
            + 'never both and never neither',
        );
      }

      rows.push(parts);
    });

    return rows;
  }

  /**
   * Fails the migration when a producer-scoped rule names a producer that does
   * not exist — the join would make it global, which is a far broader rule
   * than the author wrote.
   *
   * @param queryRunner - The running migration's query runner.
   * @param rows - The parsed rules.
   * @returns Resolves when every referenced slug exists.
   * @throws {Error} Naming the missing producers.
   */
  private async assertProducers(
    queryRunner: QueryRunner,
    rows: string[][],
  ): Promise<void> {
    const slugs = [...new Set(rows.map((row) => row[0]).filter(Boolean))];

    if (!slugs.length) {
      return;
    }

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

  /**
   * Fails the migration when a tag rule names a tag outside the vocabulary —
   * the join would turn it into a rule that states nothing, and the CHECK
   * would then reject it with a message that names the constraint rather than
   * the offending line.
   *
   * @param queryRunner - The running migration's query runner.
   * @param rows - The parsed rules.
   * @returns Resolves when every referenced tag exists.
   * @throws {Error} Naming the unknown tags.
   */
  private async assertFlavors(
    queryRunner: QueryRunner,
    rows: string[][],
  ): Promise<void> {
    const names = [...new Set(rows.map((row) => row[3]).filter(Boolean))];

    if (!names.length) {
      return;
    }

    const found = await queryRunner.query(
      'SELECT name FROM flavor WHERE name = ANY($1::text[])',
      [names],
    ) as { name: string }[];

    const known = new Set(found.map((row) => row.name));
    const missing = names.filter((name) => !known.has(name));

    if (missing.length) {
      throw new Error(`${TSV_FILE}: unknown flavors ${missing.join(',')}`);
    }
  }
}
