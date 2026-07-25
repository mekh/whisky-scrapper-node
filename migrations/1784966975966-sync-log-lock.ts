import { MigrationInterface, QueryRunner } from 'typeorm';

export class SyncLogLock1784966975966 implements MigrationInterface {
  name = 'SyncLogLock1784966975966';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sync_log"
      ADD "group" character varying(32)
    `);
    await queryRunner.query(`
      ALTER TABLE "sync_log"
      ADD "trigger" character varying(16)
    `);

    // Any run still open (success IS NULL) predates this lock. On a single
    // instance it cannot still be running, so close it out before the unique
    // index is built — two open rows sharing a group would fail its creation.
    await queryRunner.query(`
      UPDATE "sync_log"
      SET "success" = false,
          "error" = 'Interrupted: superseded by sync-orchestration deploy',
          "finishedAt" = now(),
          "updatedAt" = now()
      WHERE "success" IS NULL
    `);

    // The concurrency lock: at most one open run per exclusivity domain. The
    // domain is the group when set, else the store id; the 'g:'/'s:' prefixes
    // keep the two namespaces disjoint.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "sync_log_running_uindex" ON "sync_log" (
          (CASE
              WHEN "group" IS NOT NULL THEN 'g:' || "group"
              ELSE 's:' || "storeId"::text
          END)
      )
      WHERE "success" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX "public"."sync_log_running_uindex"
    `);
    await queryRunner.query(`
      ALTER TABLE "sync_log" DROP COLUMN "trigger"
    `);
    await queryRunner.query(`
      ALTER TABLE "sync_log" DROP COLUMN "group"
    `);
  }
}
