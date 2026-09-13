import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Installs `pg_stat_statements`, so the database can say which statements
 * its time goes to.
 *
 * The 2026-09-13 multi-instance ladder ended with the database as the
 * constraint — commits/s flat at ~350 from 500 concurrent users upward, with
 * 45 of 48 pooled connections executing at any moment and no lock or I/O
 * waits — and nothing on the host could attribute that to a query. Every
 * statement about where the time went was an inference from the scenario
 * rather than a measurement, which is the shape of reasoning
 * `docs/POSTGRES-TUNING.md` exists to warn against.
 *
 * The extension only collects once `shared_preload_libraries` names it
 * (docker-compose.yaml does, for both the production and the dev database),
 * and this migration is deliberately safe to apply before that restart
 * happens: creating it succeeds either way, and the view simply refuses to
 * answer until the library is loaded.
 *
 * The cost it adds to the serving path is a small per-statement bookkeeping
 * overhead — conventionally one to two percent — which is worth naming
 * because it is paid on exactly the path being measured.
 *
 * Creating an extension needs superuser, which the bootstrap role of the
 * `postgres` image is. On a managed database that is not a given, and this
 * migration would fail the deploy gate there rather than degrade quietly.
 */
export class PgStatStatements1789312031000 implements MigrationInterface {
  name = 'PgStatStatements1789312031000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE EXTENSION IF NOT EXISTS pg_stat_statements
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP EXTENSION IF EXISTS pg_stat_statements
    `);
  }
}
