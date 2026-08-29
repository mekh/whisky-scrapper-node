import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Data file sitting next to this migration.
 */
const TSV_FILE = '1787851200000-kb-seed-producer-flavor.tsv';

/**
 * Fields per line: producerSlug, flavor, effect, confidence, sourceUrls, note.
 */
const FIELDS = 6;

/**
 * The tag that may never be stated as a house style.
 *
 * Peat has exactly one source of truth — `producer.peatProfile` plus the peat
 * rules — and this file existing alongside it is precisely how the two would
 * come to disagree. A disagreement about peat is the defect the whole
 * knowledge base was built to end, so the importer refuses the row rather than
 * trusting a reviewer to catch it.
 *
 * `smoky` is deliberately **not** banned: non-peat smokiness is a real house
 * characteristic, and Jack Daniel's charcoal mellowing is the catalogue's
 * clearest case of a whisky that is smoky with no peat at all.
 */
const FORBIDDEN_TAG = 'peated';

/**
 * Seeds the curated house-style statements for the non-peat tags.
 *
 * These are what let the knowledge base correct the thirteen tags it does not
 * own outright: a `forbid` row removes a characteristic a model invented for a
 * distillery, and a `baseline` row grounds the classification prompt so it
 * stops inventing in the first place.
 */
export class KbSeedProducerFlavor1787851200000 implements MigrationInterface {
  public name = 'KbSeedProducerFlavor1787851200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows = this.read();

    if (!rows.length) {
      return;
    }

    await this.assertProducers(queryRunner, rows);
    await this.assertFlavors(queryRunner, rows);

    await queryRunner.query(
      `INSERT INTO producer_flavor
         ("producerId", "flavorId", effect, confidence, "sourceUrls", note)
       SELECT p.id, f.id, v.effect,
              nullif(v.confidence, ''), nullif(v."sourceUrls", ''),
              nullif(v.note, '')
       FROM unnest(
         $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]
       ) AS v(slug, flavor, effect, confidence, "sourceUrls", note)
       JOIN producer p ON p.slug = v.slug
       JOIN flavor f ON f.name = v.flavor
       ON CONFLICT ("producerId", "flavorId") DO NOTHING`,
      [
        rows.map((row) => row[0]),
        rows.map((row) => row[1]),
        rows.map((row) => row[2]),
        rows.map((row) => row[3]),
        rows.map((row) => row[4]),
        rows.map((row) => row[5]),
      ],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const slugs = [...new Set(this.read().map((row) => row[0]))];

    if (!slugs.length) {
      return;
    }

    await queryRunner.query(
      `DELETE FROM producer_flavor pf
       USING producer p
       WHERE p.id = pf."producerId" AND p.slug = ANY($1::text[])`,
      [slugs],
    );
  }

  /**
   * Parses the seed file and enforces the peat ban.
   *
   * @returns One field array per statement.
   * @throws {Error} When a line is malformed or states `peated`.
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

      if (parts[1] === FORBIDDEN_TAG) {
        throw new Error(
          `${TSV_FILE}:${index + 1} states '${FORBIDDEN_TAG}' as a house `
            + 'style; peat comes only from producer.peatProfile',
        );
      }

      rows.push(parts);
    });

    return rows;
  }

  /**
   * Fails the migration when a statement names a producer that does not exist.
   *
   * @param queryRunner - The running migration's query runner.
   * @param rows - The parsed statements.
   * @returns Resolves when every slug exists.
   * @throws {Error} Naming the missing producers.
   */
  private async assertProducers(
    queryRunner: QueryRunner,
    rows: string[][],
  ): Promise<void> {
    const slugs = [...new Set(rows.map((row) => row[0]))];

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
   * Fails the migration when a statement names a tag outside the vocabulary.
   * The join would otherwise drop the row in silence, which reads as "this
   * producer has no house style" rather than as an error.
   *
   * @param queryRunner - The running migration's query runner.
   * @param rows - The parsed statements.
   * @returns Resolves when every tag exists.
   * @throws {Error} Naming the unknown tags.
   */
  private async assertFlavors(
    queryRunner: QueryRunner,
    rows: string[][],
  ): Promise<void> {
    const names = [...new Set(rows.map((row) => row[1]))];

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
