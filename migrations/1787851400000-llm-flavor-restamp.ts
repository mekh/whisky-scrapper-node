import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes the whole catalogue a candidate for the grounded flavour re-pass.
 *
 * `lastLlmFlavorAt` is what stops a bottling being sent to the model again, so
 * every product answered under the **old** prompt is invisible to
 * `pnpm enrich-flavors` — and that prompt is exactly what has to be re-run. It
 * listed fifteen tags including `peated` and `smoky`, it was given no
 * distillery to work from, and its answers are why a Tobermory was told it
 * tasted of its peated sibling. Clearing the stamp is the whole mechanism for
 * asking again.
 *
 * A hand-curated bottling keeps its stamp: `flavorsCuratedAt` means a person
 * decided, and re-asking would spend tokens on an answer `setLlmFlavors` is
 * gated against writing anyway.
 *
 * **No tag is deleted here, deliberately.** Clearing the wrong `llm` tags is a
 * destructive sweep over the catalogue, and a destructive sweep belongs in a
 * script that can be dry-run and read before it is trusted — `pnpm
 * reconcile-flavors` already is that script, and it has already removed every
 * peat tag the knowledge base does not own. A migration runs unattended on
 * every deploy and gets no such review.
 *
 * `down()` cannot restore the timestamps it cleared — they were the only record
 * of when each product was asked — so it is a documented no-op. Nothing is
 * lost: the re-pass simply re-stamps what it answers.
 */
export class LlmFlavorRestamp1787851400000 implements MigrationInterface {
  public name = 'LlmFlavorRestamp1787851400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE product
      SET "lastLlmFlavorAt" = NULL
      WHERE "flavorsCuratedAt" IS NULL
    `);
  }

  public async down(): Promise<void> {
    /**
     * Irreversible by nature: the cleared timestamps were the only record of
     * when each bottling was last classified. Re-running the flavour pass
     * writes fresh ones.
     */
  }
}
