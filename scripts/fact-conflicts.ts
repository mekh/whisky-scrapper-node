import 'dotenv/config';
import 'reflect-metadata';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, DataSourceOptions } from 'typeorm';
import {
  addTransactionalDataSource,
  getDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';

import { ConfigModule, DbConfig } from '~config';
import { CoreWhiskyModule } from '~core/core-whisky.module';

import type { ConflictRow, StoreRateRow } from './fact-conflicts.interfaces';

/**
 * How many worst-first rows to print before saying how many were left.
 */
const LIMIT = 40;

/**
 * What a value has to look like before it is cast to a uuid.
 *
 * `storedValue` and `claimedValue` are text because they hold a foreign key
 * for `type` and `country` and a number for `abv`. Casting inside a
 * `CASE` guarded by this pattern is what keeps the ABV rows from aborting the
 * whole query — Postgres is free to evaluate a cast before the predicate that
 * was meant to exclude it, so the guard has to be on the value, not on the
 * attribute name.
 */
const UUID_SHAPE = '^[0-9a-fA-F-]{36}$';

/**
 * Standalone module: TypeORM and the whisky core graph. The script only reads.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [
        ConfigModule,
      ],
      inject: [
        DbConfig,
      ],
      useFactory: (config: DbConfig): DataSourceOptions =>
        ({ ...config }) as DataSourceOptions,
      dataSourceFactory: async (
        options?: DataSourceOptions,
      ): Promise<DataSource> => {
        if (!options) {
          throw new Error('Missing TypeORM data source options');
        }

        return getDataSourceByName('default')
          ?? addTransactionalDataSource(new DataSource(options));
      },
    }),
    CoreWhiskyModule,
  ],
})
class ConflictsModule {}

/**
 * Prints the per-shop disagreement rate.
 *
 * This table is the direct answer to "different sources of truth, different
 * data". Every other view of the log describes a product; this one describes a
 * **shop**, as a share of the listings it carries — which is what makes it
 * comparable across a shop with 4000 offers and one with 200, and what turns
 * an anonymous complaint about bad data into a name.
 *
 * @param dataSource - The live connection.
 * @returns Resolves once printed.
 */
async function reportStoreRates(dataSource: DataSource): Promise<void> {
  const rows = await dataSource.query(
    `SELECT st.slug AS store,
            count(DISTINCT c."productId")::int AS products,
            sum(c."seenCount")::int AS seen,
            (SELECT count(*)::int FROM store_product sp
             WHERE sp."storeId" = st.id AND sp."inStock") AS listings
     FROM product_fact_conflict c
     JOIN store st ON st.id = c."storeId"
     WHERE c."resolvedAt" IS NULL
     GROUP BY st.id, st.slug
     ORDER BY 2 DESC`,
  ) as StoreRateRow[];

  console.log('\nPER-SHOP DISAGREEMENT RATE');

  if (!rows.length) {
    console.log('  nothing logged yet');

    return;
  }

  console.log(
    `  ${'store'.padEnd(14)}${'disputed'.padStart(9)}`
      + `${'listings'.padStart(10)}${'rate'.padStart(8)}${'seen'.padStart(8)}`,
  );

  rows.forEach((row) => {
    const rate = row.listings
      ? `${((row.products / row.listings) * 100).toFixed(1)}%`
      : 'n/a';

    console.log(
      `  ${row.store.padEnd(14)}${String(row.products).padStart(9)}`
        + `${String(row.listings).padStart(10)}${rate.padStart(8)}`
        + `${String(row.seen).padStart(8)}`,
    );
  });
}

/**
 * Prints the queue itself, worst first.
 *
 * "Worst" is how often a claim has been seen, not how recently: a shop that has
 * repeated the same wrong country on every sync for a month is a more useful
 * thing to fix than one that said it once.
 *
 * @param dataSource - The live connection.
 * @param attribute - Narrow to one attribute, when asked.
 * @param store - Narrow to one store slug, when asked.
 * @returns Resolves once printed.
 */
async function reportQueue(
  dataSource: DataSource,
  attribute?: string,
  store?: string,
): Promise<void> {
  const rows = await dataSource.query(
    `WITH q AS (
       SELECT c.*,
              CASE WHEN c."storedValue" ~ $3 THEN c."storedValue"::uuid END
                AS "storedId",
              CASE WHEN c."claimedValue" ~ $3 THEN c."claimedValue"::uuid END
                AS "claimedId"
       FROM product_fact_conflict c
       WHERE c."resolvedAt" IS NULL
     )
     SELECT q.attribute, st.slug AS store, q."seenCount" AS seen,
            q."storedSource" AS "storedSource",
            COALESCE(p.name, '(unnamed)') AS product,
            COALESCE(sty.name, sc.code, q."storedValue") AS stored,
            COALESCE(cty.name, cc.code, q."claimedValue") AS claimed
     FROM q
     JOIN store st ON st.id = q."storeId"
     JOIN product p ON p.id = q."productId"
     LEFT JOIN type sty ON sty.id = q."storedId"
     LEFT JOIN country sc ON sc.id = q."storedId"
     LEFT JOIN type cty ON cty.id = q."claimedId"
     LEFT JOIN country cc ON cc.id = q."claimedId"
     WHERE ($1::text IS NULL OR q.attribute = $1)
       AND ($2::text IS NULL OR st.slug = $2)
     ORDER BY q."seenCount" DESC, q.attribute, p.name`,
    [attribute ?? null, store ?? null, UUID_SHAPE],
  ) as ConflictRow[];

  console.log(`\nQUEUE: ${rows.length} unresolved disagreements`);

  rows.slice(0, LIMIT).forEach((row) => {
    console.log(
      `  [${String(row.seen).padStart(3)}x] ${row.attribute.padEnd(8)}`
        + `${row.store.padEnd(12)} ${row.product}`,
    );

    console.log(
      `         stored '${row.stored}' (${row.storedSource})`
        + ` vs claimed '${row.claimed}'`,
    );
  });

  if (rows.length > LIMIT) {
    console.log(`  ... and ${rows.length - LIMIT} more`);
  }
}

/**
 * Prints the per-attribute totals.
 *
 * @param dataSource - The live connection.
 * @returns Resolves once printed.
 */
async function reportTotals(dataSource: DataSource): Promise<void> {
  const rows = await dataSource.query(
    `SELECT attribute, count(*)::int AS rows, sum("seenCount")::int AS seen
     FROM product_fact_conflict
     WHERE "resolvedAt" IS NULL
     GROUP BY 1 ORDER BY 2 DESC`,
  ) as { attribute: string; rows: number; seen: number }[];

  console.log('BY ATTRIBUTE');

  if (!rows.length) {
    console.log(
      '  the log is empty. It is written during a scrape, so it fills after '
        + 'the next sync — a reconciliation run cannot populate it, because '
        + 'rawAttrs is never persisted.',
    );

    return;
  }

  rows.forEach((row) => {
    console.log(
      `  ${row.attribute.padEnd(10)} ${String(row.rows).padStart(6)} products`
        + `, seen ${row.seen}x`,
    );
  });
}

/**
 * Prints the contradiction queue.
 *
 * @returns Resolves when the report finishes.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const valueOf = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);

    return at >= 0 ? argv[at + 1] : undefined;
  };

  initializeTransactionalContext();

  const app = await NestFactory.createApplicationContext(ConflictsModule, {
    logger: ['error', 'warn'],
  });

  try {
    const dataSource = app.get(DataSource);

    await reportTotals(dataSource);
    await reportStoreRates(dataSource);
    await reportQueue(dataSource, valueOf('--attribute'), valueOf('--store'));
  } finally {
    await app.close();
  }
}

void main();
