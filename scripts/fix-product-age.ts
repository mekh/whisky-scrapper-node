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

const SAMPLE_SIZE = 25;
const CHUNK_SIZE = 500;

/**
 * Stores whose adapter reads the age from the product's own specification
 * fields rather than from its name. For these, an age missing from the name is
 * still sourced data (OK Wine's characteristics list "Вік" explicitly), so it
 * is left alone — the audit only removes values no source ever stated.
 *
 * Keep this in sync with the adapters that set `ageYears` on a snapshot.
 */
const SPEC_AGE_STORES = ['okwine'];

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
class FixAgeModule {}

/**
 * Parsed command-line options.
 */
interface FixAgeOptions {
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
 * One product whose stored age no source supports.
 */
interface Unsupported {
  id: ID;
  age: number;
  nameOrig: string;
}

/**
 * Parses the command line.
 *
 * @param argv - Raw arguments (without node and the script path).
 * @returns The parsed options.
 */
function parseArgs(argv: string[]): FixAgeOptions {
  const storeIndex = argv.indexOf('--store');

  return {
    dryRun: argv.includes('--dry-run'),
    store: storeIndex >= 0 ? argv[storeIndex + 1] : undefined,
  };
}

/**
 * Audits `product.age` and clears the values no source ever stated.
 *
 * This is a data fix for a bug that is **already fixed in code**. Early
 * versions of the scraper searched for the age in the whole haystack — the
 * name plus the description and attribute text — where "N років" is almost
 * always brand history ("понад 250 років"), not maturation. That produced
 * NAS bottlings recorded as decades old ("Wild Turkey 101" → 60, "The Famous
 * Grouse" → 38, "Jim Beam White" → 25), concentrated in the zakaz.ua chains
 * whose listings carry long descriptions. Both engines now read the age from
 * the product name only (`normalize`: `extractAgeYears(snap.name)`), but
 * `age` is written once on insert and never updated on conflict, so every
 * value written before that fix is still in the database.
 *
 * This script therefore applies the current rule retroactively: keep an age
 * only where the name states it, or where the store itself lists it in a
 * specification field. A wrong age is worse than a missing one — it shows in
 * the product row and it makes the age filter lie.
 *
 * @returns Resolves once the audit (and any write) is done.
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  initializeTransactionalContext();

  const app = await NestFactory.createApplicationContext(FixAgeModule, {
    logger: ['warn', 'error'],
  });

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

    const skipStoreIds = new Set<ID>();

    for (const slug of SPEC_AGE_STORES) {
      const store = await stores.findOne({ slug });

      if (store) {
        skipStoreIds.add(store.id);
      }
    }

    const rows = await products.findMany(
      onlyStoreId ? { storeId: onlyStoreId } : undefined,
    );

    const withAge = rows.filter((row) => row.age !== null);
    const unsupported: Unsupported[] = [];
    let spec = 0;

    for (const row of withAge) {
      if (normalizer.extractAgeYears(row.nameOrig) !== null) {
        continue;
      }

      if (skipStoreIds.has(row.storeId)) {
        spec += 1;
        continue;
      }

      unsupported.push({
        id: row.id,
        age: row.age as number,
        nameOrig: row.nameOrig,
      });
    }

    report(withAge.length, spec, unsupported);

    if (options.dryRun) {
      console.log('Dry run — nothing written');

      return;
    }

    let cleared = 0;

    for (let at = 0; at < unsupported.length; at += CHUNK_SIZE) {
      cleared += await products.clearAges(
        unsupported.slice(at, at + CHUNK_SIZE).map((item) => item.id),
      );
    }

    console.log(`Cleared age on ${cleared} product(s)`);
  } finally {
    await app.close();
  }
}

/**
 * Prints the audit result: the counts plus a sample of what would be cleared,
 * worst (highest age) first, since an absurd age is the most telling.
 *
 * @param total - How many products carry an age.
 * @param spec - How many were kept because their store lists the age itself.
 * @param unsupported - The products whose age no source supports.
 */
function report(
  total: number,
  spec: number,
  unsupported: Unsupported[],
): void {
  console.log(
    `products with an age: ${total} | unsupported: ${unsupported.length} `
      + `| kept (store lists the age): ${spec}`,
  );

  if (!unsupported.length) {
    return;
  }

  const sorted = [...unsupported].sort((a, b) => b.age - a.age);

  console.log(
    `\nsample (${Math.min(SAMPLE_SIZE, sorted.length)} of `
      + `${sorted.length}, highest age first):`,
  );

  for (const item of sorted.slice(0, SAMPLE_SIZE)) {
    console.log(`  age=${String(item.age).padStart(3)}  ${item.nameOrig}`);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
