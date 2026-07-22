import { MigrationInterface, QueryRunner } from 'typeorm';

export class Init1783840439247 implements MigrationInterface {
  name = 'Init1783840439247';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "user" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "active" boolean NOT NULL DEFAULT false,
                "admin" boolean NOT NULL DEFAULT false,
                "name" character varying(32) NOT NULL,
                "email" character varying(64),
                "password" character varying(255) NOT NULL,
                "lastActiveAt" TIMESTAMP,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

                CONSTRAINT "PK_cace4a159ff9f2512dd42373760" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "user_email_uindex" ON "user" (
                "email"
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "permission" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "userId" uuid NOT NULL,
                "resource" character varying(32) NOT NULL,
                "action" character varying(32) NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

                CONSTRAINT "PK_3b8b97af9d9d8807e41e6f48362" PRIMARY KEY ("id"),
                CONSTRAINT "fk_permission_user"
                    FOREIGN KEY ("userId")
                    REFERENCES "user"("id")
                    ON DELETE CASCADE
                    ON UPDATE NO ACTION
            )
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "permission_user_resource_action_uindex" ON "permission" (
                "userId",
                "resource",
                "action"
            )
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP INDEX "public"."permission_user_resource_action_uindex"
        `);
    await queryRunner.query(`
            DROP TABLE "permission"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."user_email_uindex"
        `);
    await queryRunner.query(`
            DROP TABLE "user"
        `);
  }
}
