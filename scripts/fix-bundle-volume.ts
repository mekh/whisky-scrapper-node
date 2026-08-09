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
import { CoreProductService } from '~core/product';
import { CoreStoreService } from '~core/store';
import { NormalizeService } from '~scrape/normalize/normalize.service';
import { ID } from '~types';
import { ProductNameUtils } from '~utils';

const SAMPLE_SIZE = 25;

/**
 * Standalone module: TypeORM (transactional data source), the whisky core
 * graph and the deterministic normalizer. No LLM and no adapters — the audit
 * is pure text analysis over data already in the database.
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
    ConfigModule,
    CoreWhiskyModule,
  ],
  providers: [
    NormalizeService,
  ],
})
class FixBundleVolumeModule {}

/**
 * Parsed command-line options.
 */
interface FixVolumeOptions {
  /**
   * Report what would change without writing anything.
   */
  dryRun: boolean;

  /**
   * Restrict the run to a single store slug.
   */
  store?: string;
}

/**
 * One gift set whose stored volume is a single bottle's.
 */
interface Undercounted {
  id: ID;
  before: number | null;
  after: number;
  nameOrig: string;
}

/**
 * Parses the command line.
 *
 * @param argv - Raw arguments (without node and the script path).
 * @returns The parsed options.
 */
function parseArgs(argv: string[]): FixVolumeOptions {
  const storeIndex = argv.indexOf('--store');

  return {
    dryRun: argv.includes('--dry-run'),
    store: storeIndex >= 0 ? argv[storeIndex + 1] : undefined,
  };
}

/**
 * Re-derives `volumeMl` for the gift sets that name several bottles.
 *
 * This is a data fix for a bug that is **already fixed in code**. The volume
 * used to be read off the first match in the name, so a set of three 0.7 л
 * bottles was recorded as 0.7 л; `NormalizeService.extractVolumeMl` now sums
 * the bottles a `+` joins. But `volumeMl` is written once on insert and never
 * on conflict, so no re-scrape corrects the rows already stored.
 *
 * A set with a single bottle's volume is worse than one with none: the report
 * compares by volume, so a three-bottle price sits beside single bottles and
 * looks like the worst deal on the page.
 *
 * @returns Resolves once the audit (and any write) is done.
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  initializeTransactionalContext();

  const app = await NestFactory.createApplicationContext(
    FixBundleVolumeModule,
    { logger: ['warn', 'error'] },
  );

  try {
    const products = app.get(CoreProductService);
    const stores = app.get(CoreStoreService);
    const normalizer = app.get(NormalizeService);

    let onlyStoreId: ID | undefined;

    if (options.store) {
      const store = await stores.findOne({ slug: options.store });

      if (!store) {
        throw new Error(`Unknown store slug: ${options.store}`);
      }

      onlyStoreId = store.id;
    }

    const rows = await products.findMany(
      onlyStoreId ? { storeId: onlyStoreId } : undefined,
    );

    const sets = rows.filter((row) => ProductNameUtils.hasBundle(row.nameOrig));

    const undercounted: Undercounted[] = [];

    for (const row of sets) {
      const total = normalizer.extractVolumeMl(row.nameOrig);

      if (total !== null && total !== row.volumeMl) {
        undercounted.push({
          id: row.id,
          before: row.volumeMl ?? null,
          after: total,
          nameOrig: row.nameOrig,
        });
      }
    }

    report(sets.length, undercounted);

    if (options.dryRun) {
      console.log('Dry run — nothing written');

      return;
    }

    for (const item of undercounted) {
      await products.update(item.id, { volumeMl: item.after });
    }

    console.log(`Updated volume on ${undercounted.length} product(s)`);
  } finally {
    await app.close();
  }
}

/**
 * Prints the audit result: the counts plus a sample of what would change,
 * largest correction first.
 *
 * @param sets - How many products are gift sets.
 * @param undercounted - The sets whose stored volume is wrong.
 */
function report(sets: number, undercounted: Undercounted[]): void {
  console.log(
    `gift sets: ${sets} | wrong volume: ${undercounted.length}`,
  );

  if (!undercounted.length) {
    return;
  }

  const sorted = [...undercounted].sort((a, b) =>
    b.after - (b.before ?? 0) - (a.after - (a.before ?? 0))
  );

  console.log(
    `\nsample (${Math.min(SAMPLE_SIZE, sorted.length)} of `
      + `${sorted.length}, largest correction first):`,
  );

  for (const item of sorted.slice(0, SAMPLE_SIZE)) {
    console.log(
      `  ${String(item.before ?? '—').padStart(5)} -> `
        + `${String(item.after).padStart(5)}  ${item.nameOrig}`,
    );
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
