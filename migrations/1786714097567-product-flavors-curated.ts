import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProductFlavorsCurated1786714097567 implements MigrationInterface {
  name = 'ProductFlavorsCurated1786714097567';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "product"
      ADD "flavorsCuratedAt" TIMESTAMP
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "product" DROP COLUMN "flavorsCuratedAt"
    `);
  }
}
