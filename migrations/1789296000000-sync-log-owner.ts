import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records which instance holds an open sync run.
 *
 * The orphan sweep used to close every open row at boot, which is right for
 * one process and wrong for several: closing a row releases the store's
 * concurrency lock, so a restarting instance would have let a second sync
 * start on top of a sibling's live one. With the owner recorded, the sweep
 * asks whether that instance is still up before closing anything.
 *
 * Nullable, and left null on the rows already there: a run from before this
 * column existed names nobody, which the sweep reads as orphaned — correct,
 * since no live process can claim it.
 */
export class SyncLogOwner1789296000000 implements MigrationInterface {
  name = 'SyncLogOwner1789296000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sync_log"
      ADD "ownerId" character varying(64)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sync_log" DROP COLUMN "ownerId"
    `);
  }
}
