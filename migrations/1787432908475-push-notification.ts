import { MigrationInterface, QueryRunner } from 'typeorm';

export class PushNotification1787432908475 implements MigrationInterface {
  name = 'PushNotification1787432908475';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "push_subscription" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "userId" uuid NOT NULL,
                "endpoint" text NOT NULL,
                "p256dh" character varying(256) NOT NULL,
                "auth" character varying(256) NOT NULL,
                "userAgent" character varying(512),
                "lastSuccessAt" TIMESTAMP,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

                CONSTRAINT "PK_07fc861c0d2c38c1b830fb9cb5d" PRIMARY KEY ("id"),
                CONSTRAINT "fk_push_subscription_user"
                    FOREIGN KEY ("userId")
                    REFERENCES "user"("id")
                    ON DELETE CASCADE
                    ON UPDATE CASCADE
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "push_subscription_user_idx" ON "push_subscription" (
                "userId"
            )
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "push_subscription_endpoint_uindex" ON "push_subscription" (
                "endpoint"
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "push_digest_log" (
                "userId" uuid NOT NULL,
                "storeProductId" uuid NOT NULL,
                "price" numeric(12, 2) NOT NULL,
                "previousPrice" numeric(12, 2) NOT NULL,
                "capturedOn" date NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),

                CONSTRAINT "PK_49dbe1164d6076d81a9599bb68a"
                    PRIMARY KEY ("userId", "storeProductId", "capturedOn"),
                CONSTRAINT "fk_push_digest_log_user"
                    FOREIGN KEY ("userId")
                    REFERENCES "user"("id")
                    ON DELETE CASCADE
                    ON UPDATE CASCADE,
                CONSTRAINT "fk_push_digest_log_store_product"
                    FOREIGN KEY ("storeProductId")
                    REFERENCES "store_product"("id")
                    ON DELETE CASCADE
                    ON UPDATE CASCADE
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "push_digest_log_captured_idx" ON "push_digest_log" (
                "capturedOn"
            )
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP INDEX "public"."push_digest_log_captured_idx"
        `);
    await queryRunner.query(`
            DROP TABLE "push_digest_log"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."push_subscription_endpoint_uindex"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."push_subscription_user_idx"
        `);
    await queryRunner.query(`
            DROP TABLE "push_subscription"
        `);
  }
}
