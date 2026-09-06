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
import { CURRENCY_HISTORY_FLOOR } from '~constants';
import { CoreCurrencyService } from '~core/currency';
import {
  CurrencyRateSyncService,
  DomainCurrencyModule,
} from '~domain/currency';
import { SyncFileLogTime } from '~lib/sync-file-log';
import { CurrencyRateCoverageRow, CurrencyRateGap } from '~types';

/**
 * Standalone module: TypeORM plus the currency domain, which owns the fetch,
 * the normalization and the upsert. Nothing is reimplemented here — this
 * script is an entry point, so a rate written by hand and a rate written by
 * the daily job cannot differ.
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
    DomainCurrencyModule,
  ],
})
class CurrencyRatesModule {}

/**
 * Parsed command-line options.
 */
interface RatesOptions {
  /**
   * Fetch every day the source has, from `CURRENCY_HISTORY_FLOOR`. Ignored
   * when `from` is given explicitly.
   */
  full: boolean;

  /**
   * Fetch and report without writing anything.
   */
  dryRun: boolean;

  /**
   * First day to fetch, as `YYYY-MM-DD`. Undefined leaves the default to the
   * sync service (its trailing window, or the history floor under `--full`).
   */
  from?: string;

  /**
   * Last day to fetch, as `YYYY-MM-DD`.
   */
  to?: string;

  /**
   * Currency codes to fetch. Empty means the configured set.
   */
  codes: string[];
}

/**
 * Reads the flags this script accepts.
 *
 * @param argv - Arguments after the script name.
 * @returns The parsed options.
 */
function parseArgs(argv: string[]): RatesOptions {
  const codes: string[] = [];
  let from: string | undefined;
  let to: string | undefined;

  argv.forEach((arg, index) => {
    const value = argv[index + 1];
    const usable = value && !value.startsWith('--') ? value : undefined;

    if (arg === '--code' && usable) {
      codes.push(usable);
    }

    if (arg === '--from' && usable) {
      from = usable;
    }

    if (arg === '--to' && usable) {
      to = usable;
    }
  });

  return {
    full: argv.includes('--full'),
    dryRun: argv.includes('--dry-run'),
    from,
    to,
    codes,
  };
}

/**
 * Prints one timestamped progress line, so a long run is observably alive.
 *
 * @param message - What happened.
 */
function report(message: string): void {
  console.log(`${SyncFileLogTime.clock()} ${message}`);
}

/**
 * Prints what is stored per currency.
 *
 * @param rows - What is stored per currency.
 */
function reportCoverage(rows: CurrencyRateCoverageRow[]): void {
  rows.forEach((row) => {
    report(
      `${row.code}: ${row.days} day(s), ${row.firstDay}..${row.lastDay}`,
    );
  });
}

/**
 * Checks no currency's stored series is missing a day, and names any hole it
 * finds.
 *
 * Nothing should ever be found. The source publishes **every** calendar day,
 * and the handful its own first years omit are carried forward on ingest, so a
 * hole here means the stored copy lost days — worth failing the run over
 * instead of discovering months later, when a purchase happens to land on one.
 *
 * @param gaps - The gaps found.
 * @returns True when there are none.
 */
function reportGaps(gaps: CurrencyRateGap[]): boolean {
  if (!gaps.length) {
    report('Every currency is gap-free.');

    return true;
  }

  gaps.forEach((gap) => {
    report(
      `${gap.code}: MISSING ${gap.missing} day(s) between `
        + `${gap.after} and ${gap.before}`,
    );
  });

  return false;
}

/**
 * Runs the sync and reports what it did.
 *
 * @returns The process exit code.
 */
async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  initializeTransactionalContext();

  const app = await NestFactory.createApplicationContext(CurrencyRatesModule, {
    logger: ['error', 'warn'],
  });

  try {
    const sync = app.get(CurrencyRateSyncService);
    const currencies = app.get(CoreCurrencyService);
    const from = options.from
      ?? (options.full ? CURRENCY_HISTORY_FLOOR : undefined);

    const scope = [
      from ? `from ${from}` : null,
      options.to ? `to ${options.to}` : null,
    ].filter(Boolean).join(' ');

    report(
      `Syncing NBU rates${options.dryRun ? ' (dry run)' : ''}`
        + `${scope ? ` ${scope}` : ''}`,
    );

    const result = await sync.sync({
      codes: options.codes.length ? options.codes : undefined,
      from,
      to: options.to,
      dryRun: options.dryRun,
      onProgress: report,
    });

    report(
      `Done: ${result.codes.join(', ')} ${result.from}..${result.to}, `
        + `${result.fetched} day(s) fetched, ${result.written} written`,
    );

    if (options.dryRun) {
      return 0;
    }

    reportCoverage(await currencies.rateCoverage());

    const intact = reportGaps(await currencies.rateGaps());

    return intact ? 0 : 1;
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
