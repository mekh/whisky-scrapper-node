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
import { ScrapeModule, ScrapeService } from '~scrape';

/**
 * Standalone module wiring TypeORM (with the transactional data source) and the
 * scraping engine, so the dry-run can resolve `ScrapeService`.
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
    ScrapeModule,
  ],
})
class DryRunModule {}

/**
 * Scrapes one store without writing to the database and prints a summary (or,
 * with `--json`, the normalized in-stock items — used by the parity harness).
 *
 * @returns The process exit code.
 */
async function main(): Promise<number> {
  const slug = process.argv[2];
  const asJson = process.argv.includes('--json');

  if (!slug || slug.startsWith('--')) {
    process.stderr.write(
      'Usage: scrape-dry-run <slug> [--json]\n',
    );

    return 1;
  }

  initializeTransactionalContext();

  const app = await NestFactory.createApplicationContext(DryRunModule, {
    logger: ['error', 'warn'],
  });

  try {
    const scrape = app.get(ScrapeService);
    const result = await scrape.collectStore(slug, { dryRun: true });

    if (asJson) {
      process.stdout.write(`${JSON.stringify(result.items ?? [], null, 2)}\n`);

      return 0;
    }

    process.stdout.write(
      `${slug}: found=${result.found} inStock=${result.stored}\n`,
    );

    (result.items ?? []).slice(0, 3).forEach((item) => {
      process.stdout.write(
        `  ${item.name} | ${item.price} | abv=${item.abv} `
          + `vol=${item.volumeMl} age=${item.ageYears} `
          + `type=${item.whiskyType} country=${item.country} `
          + `brand=${item.brand}\n`,
      );
    });

    return 0;
  } finally {
    await app.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);

    process.exit(1);
  });
