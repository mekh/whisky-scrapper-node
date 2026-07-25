import { MigrationInterface, QueryRunner } from 'typeorm';

export class StoreConfigGroupEngine1784966974966 implements MigrationInterface {
  name = 'StoreConfigGroupEngine1784966974966';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "store_config"
      ADD "group" character varying(32)
    `);
    await queryRunner.query(`
      ALTER TABLE "store_config"
      ADD "engine" character varying(16) NOT NULL DEFAULT 'python'
    `);

    // The 19 Zakaz.ua networks are exactly the store_config rows that carry a
    // retailChain. Group them so they never sync concurrently.
    await queryRunner.query(`
      UPDATE "store_config"
      SET "group" = 'zakaz'
      WHERE "retailChain" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "store_config" DROP COLUMN "engine"
    `);
    await queryRunner.query(`
      ALTER TABLE "store_config" DROP COLUMN "group"
    `);
  }
}
