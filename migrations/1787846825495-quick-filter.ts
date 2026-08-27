import { MigrationInterface, QueryRunner } from 'typeorm';

export class QuickFilter1787846825495 implements MigrationInterface {
  name = 'QuickFilter1787846825495';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "quick_filter" (
          "id" uuid NOT NULL DEFAULT uuidv7(),
          "userId" uuid NOT NULL,
          "name" character varying(64) NOT NULL,
          "filters" jsonb NOT NULL DEFAULT '{}'::jsonb,
          "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
          "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

          CONSTRAINT "PK_98e2f7ea05b1d28b759ed0b18c1" PRIMARY KEY ("id"),
          CONSTRAINT "fk_quick_filter_user"
              FOREIGN KEY ("userId")
              REFERENCES "user"("id")
              ON DELETE CASCADE
              ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "quick_filter_user_name_uindex" ON "quick_filter" (
          "userId",
          "name"
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX "public"."quick_filter_user_name_uindex"
    `);
    await queryRunner.query(`
      DROP TABLE "quick_filter"
    `);
  }
}
