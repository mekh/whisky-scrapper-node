import { MigrationInterface, QueryRunner } from 'typeorm';

export class SyncLogFile1786356388327 implements MigrationInterface {
  name = 'SyncLogFile1786356388327';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sync_log"
      ADD "logFile" character varying(256)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sync_log" DROP COLUMN "logFile"
    `);
  }
}
