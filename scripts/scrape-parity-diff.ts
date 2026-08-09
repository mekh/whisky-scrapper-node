import 'dotenv/config';
import 'reflect-metadata';

import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

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

import type { ProductSnapshot } from '~types';
import type {
  ParityDiff,
  ParityItem,
  PythonSnapshot,
} from './parity.interfaces';

const execFileAsync = promisify(execFile);

const SCRAPPER_DIR = resolve(__dirname, '../../scrapper');

const PYTHON = process.env.PARITY_PYTHON
  ?? join(SCRAPPER_DIR, '.venv/bin/python');

const DUMPER = join(__dirname, 'scrape-parity-dump.py');

/**
 * A full catalog dump is a few MB of JSON; the default 1 MB pipe buffer is not
 * enough.
 */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Fields whose values must match exactly. Nothing here depends on the LLM, so
 * any difference is a real porting bug.
 */
const COMPARED: (keyof ParityItem)[] = [
  'url',
  'name',
  'price',
  'oldPrice',
  'promo',
  'brand',
  'volumeMl',
  'abv',
  'ageYears',
  'whiskyType',
  'country',
  'flavorTags',
];

const SAMPLE_LIMIT = 10;

/**
 * Standalone module wiring TypeORM and the scraping engine, so the harness can
 * resolve `ScrapeService`.
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
class ParityModule {}

/**
 * Reads a flag's value from the command line.
 *
 * @param name - Flag name, without the leading dashes.
 * @returns The value, or undefined when the flag is absent.
 */
function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);

  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * Projects a Python snapshot onto the compared subset.
 *
 * @param snap - The Python snapshot.
 * @returns The comparable item.
 */
function fromPython(snap: PythonSnapshot): ParityItem {
  return {
    sku: snap.store_sku,
    url: snap.url,
    name: snap.name,
    price: snap.price,
    oldPrice: snap.old_price,
    promo: snap.promo,
    brand: snap.brand,
    volumeMl: snap.volume_ml,
    abv: snap.abv,
    ageYears: snap.age_years,
    whiskyType: snap.whisky_type,
    country: snap.country,
    flavorTags: [...snap.flavor_tags].sort().join(','),
  };
}

/**
 * Projects a TypeScript snapshot onto the compared subset.
 *
 * @param snap - The engine snapshot.
 * @returns The comparable item.
 */
function fromTs(snap: ProductSnapshot): ParityItem {
  return {
    sku: snap.storeSku,
    url: snap.url,
    name: snap.name,
    price: snap.price,
    oldPrice: snap.oldPrice,
    promo: snap.promo,
    brand: snap.brand,
    volumeMl: snap.volumeMl,
    abv: snap.abv,
    ageYears: snap.ageYears,
    whiskyType: snap.whiskyType,
    country: snap.country,
    flavorTags: [...snap.flavorTags].sort().join(','),
  };
}

/**
 * Indexes comparable items by SKU.
 *
 * @param items - The items to index.
 * @returns SKU to item.
 */
function bySku(items: ParityItem[]): Map<string, ParityItem> {
  return new Map(items.map((item) => [item.sku, item]));
}

/**
 * Runs the Python dumper for a store.
 *
 * @param slug - Store slug.
 * @returns The store's normalized in-stock snapshots.
 */
async function runPython(slug: string): Promise<PythonSnapshot[]> {
  const { stdout } = await execFileAsync(PYTHON, [DUMPER, slug], {
    cwd: SCRAPPER_DIR,
    env: { ...process.env, PYTHONPATH: SCRAPPER_DIR },
    maxBuffer: MAX_BUFFER,
  });

  return JSON.parse(stdout) as PythonSnapshot[];
}

/**
 * Runs the TypeScript engine's dry run for a store.
 *
 * @param slug - Store slug.
 * @returns The store's normalized in-stock snapshots.
 */
async function runTs(slug: string): Promise<ProductSnapshot[]> {
  /**
   * The LLM pass is non-deterministic, so it is disabled for both sides: the
   * config reads the key at construction, hence the delete before boot.
   */
  delete process.env.LLM_API_KEY;

  initializeTransactionalContext();

  const app = await NestFactory.createApplicationContext(ParityModule, {
    logger: ['error', 'warn'],
  });

  try {
    const result = await app.get(ScrapeService).collectStore(slug, {
      dryRun: true,
    });

    return result.items ?? [];
  } finally {
    await app.close();
  }
}

/**
 * Compares the SKUs both engines returned, field by field.
 *
 * @param python - Python items by SKU.
 * @param ts - TypeScript items by SKU.
 * @returns Every field difference found.
 */
function diffShared(
  python: Map<string, ParityItem>,
  ts: Map<string, ParityItem>,
): ParityDiff[] {
  const diffs: ParityDiff[] = [];

  python.forEach((left, sku) => {
    const right = ts.get(sku);

    if (!right) {
      return;
    }

    COMPARED.forEach((field) => {
      if (left[field] !== right[field]) {
        diffs.push({ sku, field, python: left[field], ts: right[field] });
      }
    });
  });

  return diffs;
}

/**
 * Prints the comparison report.
 *
 * @param slug - Store slug.
 * @param python - Python items by SKU.
 * @param ts - TypeScript items by SKU.
 * @param diffs - Field differences on the shared SKUs.
 */
function report(
  slug: string,
  python: Map<string, ParityItem>,
  ts: Map<string, ParityItem>,
  diffs: ParityDiff[],
): void {
  const onlyPython = [...python.keys()].filter((sku) => !ts.has(sku));
  const onlyTs = [...ts.keys()].filter((sku) => !python.has(sku));
  const byField = new Map<string, number>();

  diffs.forEach((diff) => {
    byField.set(diff.field, (byField.get(diff.field) ?? 0) + 1);
  });

  process.stdout.write(
    `\n${slug}: python=${python.size} ts=${ts.size} `
      + `shared=${python.size - onlyPython.length} diffs=${diffs.length}\n`,
  );

  if (onlyPython.length > 0) {
    process.stdout.write(
      `  only in python (${onlyPython.length}): `
        + `${onlyPython.slice(0, SAMPLE_LIMIT).join(', ')}\n`,
    );
  }

  if (onlyTs.length > 0) {
    process.stdout.write(
      `  only in ts (${onlyTs.length}): `
        + `${onlyTs.slice(0, SAMPLE_LIMIT).join(', ')}\n`,
    );
  }

  byField.forEach((count, field) => {
    process.stdout.write(`  ${field}: ${count} differing item(s)\n`);
  });

  diffs.slice(0, SAMPLE_LIMIT).forEach((diff) => {
    process.stdout.write(
      `    ${diff.sku} ${diff.field}: python=${JSON.stringify(diff.python)} `
        + `ts=${JSON.stringify(diff.ts)}\n`,
    );
  });
}

/**
 * Writes both dumps next to each other for later inspection.
 *
 * @param dir - Target directory.
 * @param slug - Store slug.
 * @param python - The Python dump.
 * @param ts - The TypeScript dump.
 */
function saveDumps(
  dir: string,
  slug: string,
  python: PythonSnapshot[],
  ts: ProductSnapshot[],
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.python.json`),
    JSON.stringify(python, null, 2),
  );
  writeFileSync(join(dir, `${slug}.ts.json`), JSON.stringify(ts, null, 2));
}

/**
 * Runs both engines against one store and diffs their pre-database output.
 *
 * @returns The process exit code: 1 when the shared SKUs differ.
 */
async function main(): Promise<number> {
  const slug = process.argv[2];

  if (!slug || slug.startsWith('--')) {
    process.stderr.write(
      'Usage: scrape-parity-diff <slug> [--python <dump.json>] '
        + '[--ts <dump.json>] [--out <dir>]\n',
    );

    return 1;
  }

  const pythonDump = flag('python');
  const tsDump = flag('ts');
  const out = flag('out');

  const pythonSnaps = pythonDump
    ? JSON.parse(readFileSync(pythonDump, 'utf8')) as PythonSnapshot[]
    : await runPython(slug);
  const tsSnaps = tsDump
    ? JSON.parse(readFileSync(tsDump, 'utf8')) as ProductSnapshot[]
    : await runTs(slug);

  if (out) {
    saveDumps(out, slug, pythonSnaps, tsSnaps);
  }

  const python = bySku(pythonSnaps.map(fromPython));
  const ts = bySku(tsSnaps.map(fromTs));
  const diffs = diffShared(python, ts);

  report(slug, python, ts, diffs);

  return diffs.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error);

    process.exit(1);
  });
