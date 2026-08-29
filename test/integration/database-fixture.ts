import { DataSource, QueryRunner } from 'typeorm';
import { runInTransaction } from 'typeorm-transactional';

import { KbSeedProducer1787851000000 } from '../../migrations/1787851000000-kb-seed-producer';
import { KbSeedAlias1787851100000 } from '../../migrations/1787851100000-kb-seed-alias';
import { KbSeedProducerFlavor1787851200000 } from '../../migrations/1787851200000-kb-seed-producer-flavor';
import { KbSeedRule1787851300000 } from '../../migrations/1787851300000-kb-seed-rule';

/**
 * Everything a bottling owns, ordered child-before-parent so the truncate
 * names every dependant instead of relying on `CASCADE` to find them. Naming
 * them is the point: a new table referencing `product` then fails this list
 * loudly rather than being emptied by a suite that never mentioned it.
 */
const CATALOGUE_TABLES = [
  'price_snapshot',
  'push_digest_log',
  'store_product',
  'product_flavor',
  'product_fact_conflict',
  'favorite',
  'blacklist_product',
  'product',
];

/**
 * Thrown to roll the fixture transaction back once a suite has read
 * everything it needs out of it. Never leaves {@link withRolledBackFixture}.
 */
class RollbackSignal extends Error {}

/**
 * Adapts a data source to the only part of `QueryRunner` the knowledge-base
 * seed migrations use.
 *
 * They call `queryRunner.query` and nothing else, so routing that one method
 * at the data source is enough — and it is what makes the seeders run inside
 * the caller's `runInTransaction` block, where a real query runner would open
 * its own connection and escape the rollback.
 *
 * @param dataSource - The suite's data source.
 * @returns A query runner the seed migrations accept.
 */
function asQueryRunner(dataSource: DataSource): QueryRunner {
  return {
    query: (sql: string, params?: unknown[]): Promise<unknown> =>
      dataSource.query(sql, params),
  } as unknown as QueryRunner;
}

/**
 * Runs a suite's fixture setup and reads inside one transaction, then rolls
 * it back and hands the caller whatever it gathered.
 *
 * This is what lets an integration suite own its data outright. It seeds the
 * rows it asserts on — replacing the knowledge base and the catalogue
 * wholesale where it has to — and the shared development database is left
 * byte for byte as it was, whatever the suite did or how it failed.
 *
 * The consequence to write tests around: the transaction is gone by the time
 * any `it` runs, so **every database read belongs in the callback** and the
 * assertions run against the values it returns. A suite that queries from an
 * `it` body is querying the real database again.
 *
 * @param gather - Seeds the fixture and returns everything the assertions
 *   need.
 * @returns Whatever `gather` returned.
 */
export async function withRolledBackFixture<T>(
  gather: () => Promise<T>,
): Promise<T> {
  let gathered: T | null = null;

  try {
    await runInTransaction(async () => {
      gathered = await gather();

      throw new RollbackSignal();
    });
  } catch (error) {
    if (!(error instanceof RollbackSignal)) {
      throw error;
    }
  }

  if (gathered === null) {
    throw new Error('Fixture gathered nothing before the rollback');
  }

  return gathered;
}

/**
 * Empties the knowledge base.
 *
 * `flavor_rule` goes first and explicitly: its `producerId` is nullable, so
 * the global peat rules survive the cascade from `producer` and would leak
 * into a suite that thinks it started from nothing.
 *
 * @param dataSource - The suite's data source.
 * @returns Resolves once both tables are empty.
 */
export async function clearKnowledgeBase(
  dataSource: DataSource,
): Promise<void> {
  await dataSource.query('DELETE FROM flavor_rule');
  await dataSource.query('DELETE FROM producer');
}

/**
 * Empties the catalogue: bottlings, offers, prices and everything keyed on
 * them.
 *
 * `TRUNCATE` rather than `DELETE` because the development database carries
 * ~470k price snapshots and this runs per suite. It is transactional in
 * Postgres, so the caller's rollback restores every row.
 *
 * @param dataSource - The suite's data source.
 * @returns Resolves once the catalogue is empty.
 */
export async function clearCatalogue(dataSource: DataSource): Promise<void> {
  const tables = CATALOGUE_TABLES.map((table) => `"${table}"`).join(', ');

  await dataSource.query(`TRUNCATE ${tables}`);
}

/**
 * Installs the shipped knowledge base by running the four seed migrations
 * against the current transaction.
 *
 * This is what lets a suite assert on the seed without asserting on the
 * development database: the rows come from the checked-in TSVs through the
 * importers that ship them, not from whatever the review screen last wrote.
 * The migrations themselves are reused rather than reimplemented, so a change
 * to a seeder reaches the suite instead of drifting away from it.
 *
 * The lookup tables the seeders join against (`country`, `type`, `flavor`) are
 * not installed here — no migration owns them, and the seeders fail closed on
 * a code they cannot find.
 *
 * @param dataSource - The suite's data source.
 * @returns Resolves once the knowledge base is seeded.
 */
export async function installSeedKnowledgeBase(
  dataSource: DataSource,
): Promise<void> {
  await clearKnowledgeBase(dataSource);

  const runner = asQueryRunner(dataSource);

  await new KbSeedProducer1787851000000().up(runner);
  await new KbSeedAlias1787851100000().up(runner);
  await new KbSeedProducerFlavor1787851200000().up(runner);
  await new KbSeedRule1787851300000().up(runner);
}

/**
 * Makes sure the reference flavors a suite writes exist, and resolves their
 * ids.
 *
 * The vocabulary table is one of the three no migration owns (`country`,
 * `type`, `flavor`), so a suite that needs `peated` cannot simply create it —
 * the name is unique and every real database already has it. Inserting it
 * only if it is missing is what lets the suite state its prerequisite instead
 * of assuming it.
 *
 * @param dataSource - The suite's data source.
 * @param names - Flavor names the suite needs.
 * @returns Name to id, for every name asked for.
 */
export async function ensureFlavors(
  dataSource: DataSource,
  names: string[],
): Promise<Map<string, string>> {
  await dataSource.query(
    `INSERT INTO flavor (name) SELECT unnest($1::text[])
     ON CONFLICT (name) DO NOTHING`,
    [names],
  );

  const rows = await dataSource.query(
    'SELECT id, name FROM flavor WHERE name = ANY($1::text[])',
    [names],
  ) as { id: string; name: string }[];

  return new Map(rows.map((row) => [row.name, row.id]));
}
