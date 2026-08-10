import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The closed flavor vocabulary, mirroring `FLAVOR_TAGS`
 * (`src/scrape/normalize/brand-info.constants.ts`). Inlined rather than
 * imported: a migration is a historical record and must keep applying the same
 * change after the constant moves on.
 */
const KEEP = [
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
]
  .map((tag) => `'${tag}'`)
  .join(', ');

export class FlavorTaxonomyCleanup1786349100000 implements MigrationInterface {
  name = 'FlavorTaxonomyCleanup1786349100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    /**
     * The old enrichment pass merged the model's `flavor_tags` into the open
     * `flavor` lookup table without an allowlist, so it accumulated whatever
     * the model happened to answer — near-synonyms of real tags ("peaty",
     * "oaky", "woody"), single ingredients ("banana", "peanut butter"), beer
     * styles ("ipa", "stout"), and bare adjectives ("rich", "light"). Every one
     * of them shows up as a filter chip in `/meta`, which is what makes this
     * user-visible rather than merely untidy.
     *
     * Measured on a copy of the catalogue: 142 of 157 flavor rows were outside
     * the vocabulary, carrying 633 of 7 368 links. The classification pass now
     * filters its answer against the closed list, so nothing refills this.
     *
     * Deleting is safe because neither kind of link is authored by hand. The
     * keyword pass re-derives its own on the next sync of each store, and the
     * LLM pass classifies every product with no answer recorded yet — which is
     * all of them at this point. 62 products held nothing but junk tags and
     * come out of this with no flavors at all until that pass runs.
     */
    await queryRunner.query(`
      DELETE FROM "product_flavor"
      WHERE "flavorId" IN (
        SELECT "id" FROM "flavor" WHERE lower("name") NOT IN (${KEEP})
      )
    `);

    await queryRunner.query(`
      DELETE FROM "flavor"
      WHERE lower("name") NOT IN (${KEEP})
    `);
  }

  public async down(): Promise<void> {
    /**
     * Deliberately a no-op: the deleted tags and links cannot be reconstructed,
     * and re-creating the rows empty would only restore the filter chips
     * without the products behind them. Reverting is a re-run of
     * `pnpm enrich-flavors` plus the next sync, not a schema rollback.
     */
  }
}
