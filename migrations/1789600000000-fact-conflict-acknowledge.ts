import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Marks every open cross-shop contradiction acknowledged, once.
 *
 * The curation screen's rebuild makes an unacknowledged contradiction queue
 * its bottling. That is right for a disagreement nobody has read, and wrong
 * for the 790 rows open at release: the owner has already worked through
 * them, and 391 bottlings would enter the queue on deploy carrying a decision
 * already made.
 *
 * It pairs with the other half of the reversal, in `logFactConflicts`: a
 * re-sighting no longer clears `resolvedAt`, so an acknowledgement sticks
 * instead of being undone by the next sync. Without that, this migration
 * would be worth exactly one night. (`CLAUDE.md` documented the opposite
 * rule; the owner reversed it with the redesign.)
 *
 * Nothing is lost. The rows stay, every value stays, and the screen's
 * «переглянуті розбіжності» checkbox brings the whole set back on demand — a
 * contradiction is evidence whether or not it queues anything.
 *
 * `down()` is a documented no-op: the rows this stamped are
 * indistinguishable from the ones a person acknowledged afterwards, so
 * clearing the column would un-decide real decisions. Re-opening them is a
 * one-line `UPDATE` somebody can run deliberately.
 */
export class FactConflictAcknowledge1789600000000
  implements MigrationInterface {
  public name = 'FactConflictAcknowledge1789600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "product_fact_conflict"
      SET "resolvedAt" = now()
      WHERE "resolvedAt" IS NULL
    `);
  }

  public async down(): Promise<void> {
    /**
     * Deliberately empty — see the class comment.
     */
  }
}
