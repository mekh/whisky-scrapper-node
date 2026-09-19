import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives `country` an English name beside its Ukrainian one.
 *
 * The interface speaks two languages since 2026-09-10, but a country name is
 * one of the values that arrives over the wire rather than out of a message
 * catalogue, so an English session still read «Шотландія» in its filter chips,
 * its table tooltips and its collection statistics. The client cannot
 * translate what it is handed — the set is fifty-one rows and grows — so the
 * name has to come from here.
 *
 * **The fill is by `code`, not by name.** The codes are ISO (with the three
 * `GB-*` subdivisions whisky actually needs) and are what the whole app keys a
 * country by; the Ukrainian name is display text and is the one thing a later
 * edit is free to change.
 *
 * **A row the list misses falls back to its Ukrainian name** rather than
 * blocking the deploy. `NOT NULL` is what makes the column safe to read
 * unconditionally, and a country seeded after this migration was written is a
 * data gap to fix in the next one — not a reason for `migrate` to exit 1 on
 * production. It also renders as itself in the meantime, which is the stance
 * the client takes for every other vocabulary the backend grows.
 *
 * Additive and structurally reversible, so `ROLLBACK.md`'s PATH A can leave it
 * applied: nothing reads the column on the scrape path.
 */
export class CountryNameEn1789834152641 implements MigrationInterface {
  public name = 'CountryNameEn1789834152641';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "country"
        ADD "nameEn" character varying(64)
    `);
    await queryRunner.query(`
      UPDATE "country" AS c
      SET "nameEn" = v.name
      FROM (
        VALUES
          ('AM', 'Armenia'),
          ('AT', 'Austria'),
          ('AU', 'Australia'),
          ('AZ', 'Azerbaijan'),
          ('BE', 'Belgium'),
          ('BG', 'Bulgaria'),
          ('CA', 'Canada'),
          ('CH', 'Switzerland'),
          ('CU', 'Cuba'),
          ('CZ', 'Czechia'),
          ('DE', 'Germany'),
          ('DK', 'Denmark'),
          ('EE', 'Estonia'),
          ('ES', 'Spain'),
          ('FI', 'Finland'),
          ('FR', 'France'),
          ('GB', 'United Kingdom'),
          ('GB-ENG', 'England'),
          ('GB-SCT', 'Scotland'),
          ('GB-WLS', 'Wales'),
          ('GE', 'Georgia'),
          ('GR', 'Greece'),
          ('HR', 'Croatia'),
          ('HU', 'Hungary'),
          ('IE', 'Ireland'),
          ('IL', 'Israel'),
          ('IN', 'India'),
          ('IT', 'Italy'),
          ('JP', 'Japan'),
          ('KZ', 'Kazakhstan'),
          ('LK', 'Sri Lanka'),
          ('LT', 'Lithuania'),
          ('LV', 'Latvia'),
          ('MD', 'Moldova'),
          ('MX', 'Mexico'),
          ('NL', 'Netherlands'),
          ('NO', 'Norway'),
          ('NZ', 'New Zealand'),
          ('PL', 'Poland'),
          ('PT', 'Portugal'),
          ('RO', 'Romania'),
          ('SE', 'Sweden'),
          ('SG', 'Singapore'),
          ('SI', 'Slovenia'),
          ('SK', 'Slovakia'),
          ('TR', 'Turkey'),
          ('TW', 'Taiwan'),
          ('UA', 'Ukraine'),
          ('US', 'United States'),
          ('XX', 'Other countries'),
          ('ZA', 'South Africa')
      ) AS v(code, name)
      WHERE c.code = v.code
    `);
    await queryRunner.query(`
      UPDATE "country"
      SET "nameEn" = "nameUa"
      WHERE "nameEn" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "country"
      ALTER COLUMN "nameEn" SET NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "country"
        DROP COLUMN "nameEn"
    `);
  }
}
