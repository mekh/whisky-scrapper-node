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
import { CoreFlavorService } from '~core/flavor';
import { CoreProductService } from '~core/product';
import { LlmFlavorService, ScrapeModule } from '~scrape';
import { FlavorCandidateRow, ID } from '~types';

/**
 * How often to print a progress line, in classified items.
 */
const PROGRESS_EVERY = 200;

/**
 * How many classified samples to print, so an operator can eyeball the tags
 * before committing a full run.
 */
const SAMPLE_SIZE = 15;

/**
 * Standalone module: TypeORM (transactional data source) plus the scraping
 * engine, which owns the classification pass.
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
class EnrichFlavorsModule {}

/**
 * Parsed command-line options.
 */
interface EnrichOptions {
  /**
   * Classify and report without writing anything.
   */
  dryRun: boolean;

  /**
   * Restrict to one store's products, or undefined for the whole catalogue.
   */
  store?: string;

  /**
   * Stop after this many candidates. Useful for costing a model before
   * committing to a full sweep.
   */
  limit?: number;
}

/**
 * How the run turned out, per outcome.
 */
interface EnrichTally {
  /**
   * Products the model recognized well.
   */
  high: number;

  /**
   * Products the model only partly recognized.
   */
  low: number;

  /**
   * Products the model did not recognize; these get no tags.
   */
  unknown: number;

  /**
   * Products the model never answered for, because their batch failed. These
   * stay unstamped so a later run retries them.
   */
  unanswered: number;

  /**
   * Products that ended up with at least one tag.
   */
  tagged: number;
}

/**
 * Parses the command line.
 *
 * @param argv - Raw arguments (without node and the script path).
 * @returns The parsed options.
 */
function parseArgs(argv: string[]): EnrichOptions {
  const value = (flag: string): string | undefined => {
    const next = argv[argv.indexOf(flag) + 1];

    return argv.includes(flag) && next && !next.startsWith('--')
      ? next
      : undefined;
  };

  const limit = value('--limit');

  return {
    dryRun: argv.includes('--dry-run'),
    store: value('--store'),
    limit: limit ? Number.parseInt(limit, 10) : undefined,
  };
}

/**
 * Counts the outcomes of a classified batch.
 *
 * @param candidates - The classified candidates.
 * @returns The per-outcome tally.
 */
function tally(candidates: FlavorCandidateRow[]): EnrichTally {
  const counts: EnrichTally = {
    high: 0,
    low: 0,
    unknown: 0,
    unanswered: 0,
    tagged: 0,
  };

  candidates.forEach((item) => {
    if (!item.llmFlavorChecked) {
      counts.unanswered += 1;

      return;
    }

    if (item.llmFlavorConfidence === 'high') {
      counts.high += 1;
    } else if (item.llmFlavorConfidence === 'low') {
      counts.low += 1;
    } else {
      counts.unknown += 1;
    }

    if (item.llmFlavorTags?.length) {
      counts.tagged += 1;
    }
  });

  return counts;
}

/**
 * Prints the outcome tally plus a handful of classified samples.
 *
 * @param candidates - The classified candidates.
 */
function report(candidates: FlavorCandidateRow[]): void {
  const counts = tally(candidates);

  console.log('\nOutcomes');
  console.log(`  high        ${String(counts.high).padStart(6)}`);
  console.log(`  low         ${String(counts.low).padStart(6)}`);
  console.log(`  unknown     ${String(counts.unknown).padStart(6)}`);
  console.log(`  unanswered  ${String(counts.unanswered).padStart(6)}`);
  console.log(`  tagged      ${String(counts.tagged).padStart(6)}`);

  const samples = candidates
    .filter((item) => item.llmFlavorChecked)
    .slice(0, SAMPLE_SIZE);

  if (!samples.length) {
    return;
  }

  console.log('\nSamples');

  samples.forEach((item) => {
    const tags = item.llmFlavorTags?.length
      ? item.llmFlavorTags.join(', ')
      : '-';

    console.log(`  [${item.llmFlavorConfidence}] ${item.name} -> ${tags}`);
  });
}

/**
 * Writes the classified tags back, one product at a time. Candidates the model
 * never answered for are skipped so their `lastLlmFlavorAt` stays null and a
 * later run retries them.
 *
 * @param products - The product core service.
 * @param flavors - The flavor core service, to resolve tag names to ids.
 * @param candidates - The classified candidates.
 * @returns How many products were written.
 */
async function write(
  products: CoreProductService,
  flavors: CoreFlavorService,
  candidates: FlavorCandidateRow[],
): Promise<number> {
  const answered = candidates.filter((item) => item.llmFlavorChecked);

  const names = [
    ...new Set(answered.flatMap((item) => item.llmFlavorTags ?? [])),
  ];

  const flavorIds = await flavors.resolveByName(names);

  let written = 0;

  for (const item of answered) {
    const ids = (item.llmFlavorTags ?? [])
      .map((tag) => flavorIds.get(tag))
      .filter((id): id is ID => id !== undefined);

    /**
     * One answer, written to every bottling sharing the name. Two sizes of a
     * whisky are two rows and one flavour profile; the query asks once and the
     * write fans out, so they cannot end up disagreeing.
     */
    const targets = item.groupIds?.length ? item.groupIds : [item.id];

    for (const target of new Set(targets)) {
      await products.setLlmFlavors(target, ids);

      written += 1;
    }
  }

  return written;
}

/**
 * Classifies the flavor profile of stored products through the LLM and records
 * the answers.
 *
 * The keyword pass can only find a flavor a listing spells out, which leaves
 * most of the catalogue untagged — and the report's main use is *excluding* a
 * flavor, which silently excludes nothing on an untagged product. This sweeps
 * the stored rows once; new SKUs are classified by the sync pipeline as they
 * arrive.
 *
 * Re-runnable: only products with no LLM answer yet are selected, and an
 * answered product is stamped even when the answer was "unknown", so a second
 * run neither re-asks nor re-pays for it. Products whose batch failed stay
 * unstamped and are retried.
 *
 * Unlike the other backfill scripts this one only writes flavor links, so it
 * takes no sync lock and is safe to run while stores sync.
 *
 * @returns The process exit code: 1 when nothing could be classified, else 0.
 */
async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  initializeTransactionalContext();

  const app = await NestFactory.createApplicationContext(EnrichFlavorsModule, {
    logger: ['error', 'warn'],
  });

  try {
    const products = app.get(CoreProductService);
    const flavors = app.get(CoreFlavorService);
    const llmFlavor = app.get(LlmFlavorService);

    if (!llmFlavor.enabled) {
      console.error(
        'LLM is not configured — set LLM_API_KEY and LLM_MODEL '
          + '(optionally LLM_FLAVOR_MODEL to use a different model here).',
      );

      return 1;
    }

    const all = await products.findFlavorCandidates(options.store);
    const candidates = options.limit ? all.slice(0, options.limit) : all;

    console.log(
      `Classifying ${candidates.length} of ${all.length} unclassified `
        + `product(s)${options.store ? ` in ${options.store}` : ''}`,
    );

    if (!candidates.length) {
      console.log('Nothing to do.');

      return 0;
    }

    await llmFlavor.classify(candidates, (done, total) => {
      if (done % PROGRESS_EVERY === 0 || done === total) {
        console.log(`  ${done}/${total}`);
      }
    });

    report(candidates);

    if (options.dryRun) {
      console.log('\nDry run — nothing written');

      return 0;
    }

    const written = await write(products, flavors, candidates);

    console.log(`\nWrote flavor answers for ${written} product(s)`);

    /**
     * Zero answers over a non-empty candidate set is a systemic failure (bad
     * key, bad model slug, provider down), not a catalogue of unrecognized
     * bottlings — those would still be answered, as "unknown".
     */
    if (!written) {
      console.error('No product was classified — check the LLM configuration.');

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
