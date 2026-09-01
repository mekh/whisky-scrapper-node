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
import { CoreProductService } from '~core/product';
import { CoreStoreService } from '~core/store';
import { SyncEngine } from '~enums';
import { SyncFileLogTime } from '~lib/sync-file-log';
import { ScrapeModule, ScrapeService } from '~scrape';
import {
  ID,
  ProductSnapshot,
  ScrapeProgressEvent,
  ScrapeProgressReporter,
} from '~types';

/**
 * The columns a backfill run can fill, in report order.
 */
const FIELDS = [
  'abv',
  'typeId',
  'countryId',
] as const;

/**
 * Column labels padded to a fixed width so the report lines up.
 */
const LABEL_WIDTH = 10;

/**
 * How many null values each fillable canonical column still holds.
 */
type NullCounts = Record<typeof FIELDS[number], number>;

/**
 * Standalone module: TypeORM (transactional data source) plus the scraping
 * engine, since the backfill re-runs the real collection pipeline.
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
    ScrapeModule,
  ],
})
class BackfillModule {}

/**
 * Parsed command-line options.
 */
interface BackfillOptions {
  /**
   * Scrape and report what would be filled without writing anything.
   */
  dryRun: boolean;

  /**
   * Store slugs to run, in order. Empty means every active `ts` store.
   */
  stores: string[];
}

/**
 * Parses the command line.
 *
 * @param argv - Raw arguments (without node and the script path).
 * @returns The parsed options.
 */
function parseArgs(argv: string[]): BackfillOptions {
  const stores: string[] = [];

  argv.forEach((arg, index) => {
    const value = argv[index + 1];

    if (arg === '--store' && value && !value.startsWith('--')) {
      stores.push(value);
    }
  });

  return { dryRun: argv.includes('--dry-run'), stores };
}

/**
 * Counts, per fillable canonical column, the nulls a store's offers see.
 *
 * @param products - The product core service.
 * @param storeId - The store to count.
 * @returns The null count per column.
 */
async function countNulls(
  products: CoreProductService,
  storeId: ID,
): Promise<NullCounts> {
  const rows = await products.findCarriedByStore(storeId);

  const counts = Object.fromEntries(
    FIELDS.map((field) => [field, 0]),
  ) as NullCounts;

  rows.forEach((row) => {
    FIELDS.forEach((field) => {
      if (row[field] === null) {
        counts[field] += 1;
      }
    });
  });

  return counts;
}

/**
 * Counts, per column, how many of a store's null values the scraped items
 * carry a value for. An upper bound: a country the `country` table does not
 * know is never stored.
 *
 * Brand is not among the columns: the label a report prints comes from the
 * knowledge base's producer, and `pnpm reconcile-flavors` is what fills that.
 *
 * @param products - The product core service.
 * @param storeId - The store the items belong to.
 * @param items - The in-stock snapshots the dry run produced.
 * @returns The per-column count of nulls the run could fill.
 */
async function countFillable(
  products: CoreProductService,
  storeId: ID,
  items: ProductSnapshot[],
): Promise<NullCounts> {
  const rows = await products.findCarriedByStore(storeId);
  const bySku = new Map(items.map((item) => [item.storeSku, item]));

  const counts = Object.fromEntries(
    FIELDS.map((field) => [field, 0]),
  ) as NullCounts;

  rows.forEach((row) => {
    const item = bySku.get(row.sku);

    if (!item) {
      return;
    }

    const offered: Record<typeof FIELDS[number], unknown> = {
      abv: item.abv,
      typeId: item.whiskyType,
      countryId: item.country,
    };

    FIELDS.forEach((field) => {
      if (row[field] === null && offered[field] !== null) {
        counts[field] += 1;
      }
    });
  });

  return counts;
}

/**
 * Renders one progress event as a console line, or null for the events that
 * would only repeat what the final report says. The wording mirrors the
 * orchestrator's per-sync log files, so an operator reads one vocabulary.
 *
 * @param event - The progress event.
 * @returns The line, or null when the event is not worth a line here.
 */
function progressLine(event: ScrapeProgressEvent): string | null {
  switch (event.kind) {
    case 'page':
      return `page ${event.page}: ${event.added} new `
        + `(${event.total} collected so far)`;
    case 'fetched':
      return `listing fetched: ${event.found} item(s), `
        + `${event.inStock} in stock`;
    case 'enrich':
      return `details ${event.done}/${event.pending}`;
    case 'detail-failed':
      return `detail fetch failed for ${event.url}: ${event.error}`;
    case 'llm':
      return `LLM ${event.pass} pass: ${event.pending} item(s) to ask about`;
    case 'llm-deadline':
      return `LLM ${event.pass} pass skipped: out of LLM budget, `
        + `${event.pending} item(s) left for the next run`;
    case 'persisted':
      return `persisted: ${event.stored} stored, ${event.added} added, `
        + `${event.addedProducts} new bottling(s), `
        + `${event.removed} flagged out of stock`;
    case 'listing-incomplete':
      return `listing incomplete (${event.stop}): out-of-stock sweep skipped `
        + `(${event.inStock} in stock vs ${event.baseline} stored)`;
    case 'stock-drop':
      return `stock dropped sharply (${event.inStock} in stock vs `
        + `${event.baseline} stored); listing reached its end, sweeping anyway`;
    default:
      return null;
  }
}

/**
 * Builds the progress sink that mirrors the engine's events to stdout, so a
 * multi-hour run is observably alive: every listing page, every tenth detail
 * page, the LLM passes and the final persist each print one timestamped line.
 *
 * @param slug - The store the lines belong to.
 * @returns The progress reporter.
 */
function buildProgressReporter(slug: string): ScrapeProgressReporter {
  return (event: ScrapeProgressEvent): void => {
    const line = progressLine(event);

    if (line !== null) {
      console.log(`${SyncFileLogTime.clock()} ${slug}: ${line}`);
    }
  };
}

/**
 * Adds one store's counts into a running total.
 *
 * @param total - The accumulated counts.
 * @param counts - The store's counts.
 * @returns A new total.
 */
function addCounts(total: NullCounts, counts: NullCounts): NullCounts {
  return Object.fromEntries(
    FIELDS.map((field) => [field, total[field] + counts[field]]),
  ) as NullCounts;
}

/**
 * Prints a before/after null-count block.
 *
 * @param title - What the block describes (a store slug, or the total).
 * @param before - Null counts before the run.
 * @param after - Null counts after the run (or, on a dry run, the projection).
 */
function report(
  title: string,
  before: NullCounts,
  after: NullCounts,
): void {
  console.log(`\n${title}`);

  FIELDS.forEach((field) => {
    const filled = before[field] - after[field];
    const delta = filled > 0 ? `  (-${filled})` : '';

    console.log(
      `  ${field.padEnd(LABEL_WIDTH)}`
        + `${String(before[field]).padStart(6)} -> `
        + `${String(after[field]).padStart(6)}${delta}`,
    );
  });
}

/**
 * Runs one store and reports how its null counts moved.
 *
 * @param products - The product core service.
 * @param stores - The store core service.
 * @param scrape - The scrape engine.
 * @param slug - The store to run.
 * @param dryRun - Whether to project the result instead of writing it.
 * @returns The store's before and after counts.
 * @throws {Error} When the store is unknown.
 */
async function backfillStore(
  products: CoreProductService,
  stores: CoreStoreService,
  scrape: ScrapeService,
  slug: string,
  dryRun: boolean,
): Promise<{ before: NullCounts; after: NullCounts }> {
  const store = await stores.findOne({ slug });

  if (!store) {
    throw new Error(`Unknown store slug: ${slug}`);
  }

  const before = await countNulls(products, store.id);

  const result = await scrape.collectStore(slug, {
    backfill: true,
    dryRun,
    reporter: buildProgressReporter(slug),
  });

  let after = await countNulls(products, store.id);

  if (dryRun) {
    const fillable = await countFillable(
      products,
      store.id,
      result.items ?? [],
    );

    after = Object.fromEntries(
      FIELDS.map((field) => [field, before[field] - fillable[field]]),
    ) as NullCounts;
  }

  report(
    `${slug}: found=${result.found} stored=${result.stored} `
      + `added=${result.added} removed=${result.removed}`,
    before,
    after,
  );

  return { before, after };
}

/**
 * Re-scrapes stores in backfill mode so the bottlings written before the
 * parser could read a field get it filled in.
 *
 * Filling a null is now what every sync does — the canonical write is
 * fill-if-null by default — so what backfill mode still changes is *which
 * items a run bothers to look at*: it waives the "new to this store" half of
 * every enrichment gate, so stored offers get their detail pages fetched and
 * their fields asked about again.
 *
 * Age and volume are deliberately not in the report. They are components of a
 * bottling's identity, frozen when the row is created, so a backfill cannot
 * change them — a wrong one is a manual merge, not a sweep.
 *
 * Counts are per store offer but the fills are catalogue-wide, so a store's
 * nulls can legitimately drop because a *different* store's sync answered for
 * the same whisky.
 *
 * This bypasses the `sync_log` lock the orchestrator takes, so it must not run
 * while the same store is syncing from the cron or the sync endpoint.
 *
 * @returns The process exit code: 1 when any store failed, 0 otherwise.
 */
async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  initializeTransactionalContext();

  const app = await NestFactory.createApplicationContext(BackfillModule, {
    logger: ['error', 'warn'],
  });

  try {
    const products = app.get(CoreProductService);
    const stores = app.get(CoreStoreService);
    const scrape = app.get(ScrapeService);

    const configured = await stores.findAllWithConfig();
    const slugs = options.stores.length
      ? options.stores
      : configured
        .filter((store) => store.active && store.engine === SyncEngine.TS)
        .map((store) => store.slug);

    console.log(
      `Backfilling ${slugs.length} store(s): ${slugs.join(', ')}`,
    );
    console.log(
      'This bypasses the sync lock — do not sync these stores meanwhile.',
    );

    const empty = Object.fromEntries(
      FIELDS.map((field) => [field, 0]),
    ) as NullCounts;

    let before = empty;
    let after = empty;
    const failed: string[] = [];

    for (const slug of slugs) {
      try {
        const counts = await backfillStore(
          products,
          stores,
          scrape,
          slug,
          options.dryRun,
        );

        before = addCounts(before, counts.before);
        after = addCounts(after, counts.after);
      } catch (error) {
        failed.push(slug);
        console.error(`${slug}: FAILED — ${(error as Error).message}`);
      }
    }

    report(options.dryRun ? 'total (projected)' : 'total', before, after);

    if (options.dryRun) {
      console.log('\nDry run — nothing written');
    }

    if (failed.length) {
      console.error(`\nFailed store(s): ${failed.join(', ')}`);

      return 1;
    }

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
