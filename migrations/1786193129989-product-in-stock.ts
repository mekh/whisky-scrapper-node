import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProductInStock1786193129989 implements MigrationInterface {
  name = 'ProductInStock1786193129989';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Every existing row is in stock: until this migration, products reported
    // out of stock were physically deleted, so only in-stock rows remain.
    await queryRunner.query(`
      ALTER TABLE "product"
      ADD "inStock" boolean NOT NULL DEFAULT true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "product" DROP COLUMN "inStock"
    `);
  }
}
