import { MigrationInterface, QueryRunner } from 'typeorm';

export class DashboardCapturedIndex1787387641985 implements MigrationInterface {
  name = 'DashboardCapturedIndex1787387641985';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE INDEX "price_snapshot_captured_idx" ON "price_snapshot" (
                "capturedOn"
            )
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP INDEX "public"."price_snapshot_captured_idx"
        `);
  }
}
