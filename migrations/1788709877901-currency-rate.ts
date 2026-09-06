import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Storage for the National Bank of Ukraine's official exchange rates, so a
 * price recorded in hryvnia can be shown in another currency at the rate of
 * the day it belongs to rather than today's.
 *
 * Two tables, and the split is deliberate. `currency` is a lookup in the shape
 * of `country`: picker options come from the database in this codebase, and a
 * `SELECT DISTINCT` over the rates could express neither the base currency
 * (which has no rate against itself) nor the name and symbol a client renders.
 * `currency_rate` is the time series, one row per currency per calendar day,
 * enforced by a unique index exactly as `price_snapshot` does for one offer
 * per day — which is what lets the sync be a single
 * `INSERT ... ON CONFLICT DO UPDATE` that any number of runs a day may repeat.
 *
 * `rate` is `numeric(18,6)`, not the shared `numeric(12,2)` of a price: a
 * normalized NBU rate carries up to six decimals across the hryvnia's
 * high-inflation years (15.768556 on 2014-12-31), so the price scale would
 * silently truncate two thirds of the history.
 *
 * The three currency rows are seeded here because they are static reference
 * data with no external dependency. The **rates** deliberately are not: they
 * come from an HTTP API, and migrations gate every deploy, so they are filled
 * by `pnpm rates` and kept current by the daily job instead.
 */
export class CurrencyRate1788709877901 implements MigrationInterface {
  public name = 'CurrencyRate1788709877901';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "currency" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "isBase" boolean NOT NULL DEFAULT false,
                "active" boolean NOT NULL DEFAULT true,
                "numericCode" integer NOT NULL,
                "code" character varying(8) NOT NULL,
                "nameUa" character varying(64) NOT NULL,
                "symbol" character varying(8) NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

                CONSTRAINT "PK_3cda65c731a6264f0e444cc9b91" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "currency_code_uindex" ON "currency" (
                "code"
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "currency_rate" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "currencyId" uuid NOT NULL,
                "rate" numeric(18, 6) NOT NULL,
                "effectiveOn" date NOT NULL,
                "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),

                CONSTRAINT "PK_a92517ae58f0f116bc0f792f878" PRIMARY KEY ("id"),
                CONSTRAINT "fk_currency_rate_currency"
                    FOREIGN KEY ("currencyId")
                    REFERENCES "currency"("id")
                    ON DELETE CASCADE
                    ON UPDATE CASCADE
            )
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "currency_rate_currency_effective_uindex" ON "currency_rate" (
                "currencyId",
                "effectiveOn"
            )
        `);

    /**
     * The names are the NBU's own (`txt`), so the catalogue and the rate
     * source cannot disagree on what a code is called. `ON CONFLICT DO
     * NOTHING` makes the seed a no-op where a row already exists, which keeps
     * this safe against a database someone has already populated by hand.
     */
    await queryRunner.query(`
            INSERT INTO "currency" (
                "isBase", "numericCode", "code", "nameUa", "symbol"
            )
            VALUES
                (true, 980, 'UAH', 'Гривня', '₴'),
                (false, 840, 'USD', 'Долар США', '$'),
                (false, 978, 'EUR', 'Євро', '€')
            ON CONFLICT ("code") DO NOTHING
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP INDEX "public"."currency_rate_currency_effective_uindex"
        `);
    await queryRunner.query(`
            DROP TABLE "currency_rate"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."currency_code_uindex"
        `);
    await queryRunner.query(`
            DROP TABLE "currency"
        `);
  }
}
