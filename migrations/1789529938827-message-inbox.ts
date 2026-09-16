import { MigrationInterface, QueryRunner } from 'typeorm';

export class MessageInbox1789529938827 implements MigrationInterface {
  name = 'MessageInbox1789529938827';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "message" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "createdByUserId" uuid,
                "kind" character varying(24) NOT NULL,
                "payload" jsonb NOT NULL DEFAULT '{}',
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

                CONSTRAINT "PK_ba01f0a3e0123651915008bc578" PRIMARY KEY ("id"),
                CONSTRAINT "fk_message_created_by_user"
                    FOREIGN KEY ("createdByUserId")
                    REFERENCES "user"("id")
                    ON DELETE SET NULL
                    ON UPDATE CASCADE
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "message_kind_created_idx" ON "message" (
                "kind",
                "createdAt"
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "message_recipient" (
                "messageId" uuid NOT NULL,
                "userId" uuid NOT NULL,
                "readAt" TIMESTAMP,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),

                CONSTRAINT "PK_55506c50bb8d63db101521c5196" PRIMARY KEY ("messageId", "userId"),
                CONSTRAINT "fk_message_recipient_message"
                    FOREIGN KEY ("messageId")
                    REFERENCES "message"("id")
                    ON DELETE CASCADE
                    ON UPDATE CASCADE,
                CONSTRAINT "fk_message_recipient_user"
                    FOREIGN KEY ("userId")
                    REFERENCES "user"("id")
                    ON DELETE CASCADE
                    ON UPDATE CASCADE
            )
        `);
    /**
     * The one index the inbox reads through, and an expression index that
     * `@Index` cannot spell — hence `synchronize: false` on the entity and
     * this statement by hand.
     *
     * Its three parts are exactly the list query's ORDER BY
     * (`(readAt IS NULL) DESC, messageId DESC` within one user), and its
     * leading two columns also serve the unread count's
     * `WHERE userId = $1 AND readAt IS NULL`. One index, both reads.
     */
    await queryRunner.query(`
            CREATE INDEX "message_recipient_inbox_idx" ON "message_recipient" (
                "userId",
                (("readAt" IS NULL)) DESC,
                "messageId" DESC
            )
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP INDEX "public"."message_recipient_inbox_idx"
        `);
    await queryRunner.query(`
            DROP TABLE "message_recipient"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."message_kind_created_idx"
        `);
    await queryRunner.query(`
            DROP TABLE "message"
        `);
  }
}
