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
import { LlmClientService } from '~scrape/llm/llm-client.service';
import { LlmNameExtractionService } from '~scrape/llm/llm-name-extraction.service';
import { ID } from '~types';
import { NAME_TAG_WORDS, ProductNameUtils } from '~utils';

import type { LlmNameCandidate } from '~scrape/llm/llm.interfaces';

const SAMPLE_SIZE = 20;
const PROGRESS_EVERY = 500;

/**
 * Mirrors `CHUNK_SIZE` in `LlmNameExtractionService`, only to state up front
 * how many batches the run will take.
 */
const LLM_CHUNK_SIZE = 40;

/**
 * Standalone module wiring TypeORM (with the transactional data source), the
 * whisky core graph and the name-extraction service. `ScrapeModule` is not
 * imported: this script needs neither the adapters nor the collector.
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
    LlmClientService,
    LlmNameExtractionService,
  ],
})
class CleanNamesModule {}

/**
 * Parsed command-line options.
 */
interface CleanNamesOptions {
  /**
   * Report what would change without writing anything.
   */
  dryRun: boolean;

  /**
   * Skip the LLM pass and use the deterministic cleanup only.
   */
  noLlm: boolean;

  /**
   * Restrict the run to a single store slug.
   */
  store?: string;
}

/**
 * One product about to be rewritten.
 */
interface NameRewrite {
  /**
   * Product id.
   */
  id: ID;

  /**
   * Raw scraped name the new value is derived from.
   */
  nameOrig: string;

  /**
   * Name currently stored.
   */
  before: string | null;

  /**
   * Name the run computed.
   */
  after: string | null;
}

/**
 * Reads the command-line options.
 *
 * @returns The parsed options.
 */
function parseArgs(): CleanNamesOptions {
  const argv = process.argv.slice(2);
  const storeIndex = argv.indexOf('--store');

  return {
    dryRun: argv.includes('--dry-run'),
    noLlm: argv.includes('--no-llm'),
    store: storeIndex >= 0 ? argv[storeIndex + 1] : undefined,
  };
}

/**
 * Folds a name to the key that groups its spelling variants.
 *
 * The extraction is told to copy the source spelling verbatim, so whatever the
 * stores disagree about arrives twice. Measured on the catalogue, they disagree
 * about exactly four things and never about anything else: capitalisation
 * (`Caol Ila` / `Caol ila`, `Tenjaku` / `TENJAKU`), a Latin diacritic
 * (`Agitator Rök` / `Agitator Rok`, `Éiregold` / `Eiregold`), an article
 * anywhere in the name (`The Glenlivet` / `Glenlivet`,
 * `Glenmorangie The Lasanta` / `Glenmorangie Lasanta`, 37 pairs), and
 * punctuation or spacing (`Ballantine's Finest` / `Ballantines Finest`,
 * `J&B` / `J & B`, `Balvenie Doublewood` / `Balvenie Double Wood`, 35 groups).
 * Every group the key produced was one product listed two ways — none merged
 * two whiskies.
 *
 * The diacritic fold is deliberately Latin-only and recomposes afterwards: a
 * blanket one decomposes Cyrillic `й` into `и`, which would merge words that
 * are genuinely different.
 *
 * @param name - The name to fold.
 * @returns The grouping key.
 */
function spellingKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/([A-Za-z])[̀-ͯ]+/g, '$1')
    .normalize('NFC')
    .toLowerCase()
    .replace(/(^|\s)the(\s|$)/g, ' ')
    .replace(/[^0-9a-zа-яіїєґ]/g, '');
}

/**
 * Picks one spelling per group of variants, by majority across the catalogue.
 *
 * Letting the most common spelling win needs no judgement and cannot invent a
 * spelling no store used. Ties go to the longer variant, which is the brand's
 * own typography — `Grant's Triple Wood` over `Grants Triplewood`,
 * `The Glenlivet` over `Glenlivet` — and then to a plain comparison, so the
 * result does not depend on row order.
 *
 * @param names - The resolved name of every row, nulls included.
 * @returns Grouping key to the spelling that should be stored.
 */
function canonicalSpelling(names: (string | null)[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();

  for (const name of names) {
    if (name === null) {
      continue;
    }

    const key = spellingKey(name);
    const variants = counts.get(key) ?? new Map<string, number>();

    variants.set(name, (variants.get(name) ?? 0) + 1);
    counts.set(key, variants);
  }

  const winners = new Map<string, string>();

  for (const [key, variants] of counts) {
    const ranked = [...variants.entries()].sort((a, b) =>
      b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0])
    );

    winners.set(key, ranked[0][0]);
  }

  return winners;
}

/**
 * Drops a trailing provenance or category tag from a name, but only when the
 * catalogue itself proves the shorter name is the same product.
 *
 * `Balblair Highland` and `Balblair` are one bottling listed two ways, while
 * `Clan Denny Islay` and `Clan Denny Speyside` are two different whiskies from
 * an independent bottler — and no rule over a single name can tell them apart.
 * What separates them is the catalogue: some store lists a bare `Balblair`,
 * nobody lists a bare `Clan Denny`. So the tag comes off only when the
 * shortened name is one a store actually used.
 *
 * @param names - The resolved name of every row, nulls included.
 * @returns Name to the shortened name, for the names that collapse.
 */
function collapseTags(names: (string | null)[]): Map<string, string> {
  const attested = new Set(
    names.filter((name): name is string => name !== null)
      .map((name) => name.toLowerCase()),
  );

  const collapsed = new Map<string, string>();

  for (const name of new Set(names)) {
    if (name === null) {
      continue;
    }

    let current = name;

    for (let cut = current.lastIndexOf(' '); cut > 0;) {
      const tag = current.slice(cut + 1).toLowerCase();
      const shorter = current.slice(0, cut);

      if (!NAME_TAG_WORDS.has(tag) || !attested.has(shorter.toLowerCase())) {
        break;
      }

      current = shorter;
      cut = current.lastIndexOf(' ');
    }

    if (current !== name) {
      collapsed.set(name, current);
    }
  }

  return collapsed;
}

/**
 * Resolves the store id to filter on, when `--store` was given.
 *
 * @param stores - The core store service.
 * @param slug - The store slug, or undefined for the whole catalogue.
 * @returns The store id, or undefined when no filter applies.
 * @throws {Error} When the slug matches no store.
 */
async function resolveStoreId(
  stores: CoreStoreService,
  slug?: string,
): Promise<ID | undefined> {
  if (!slug) {
    return undefined;
  }

  const store = await stores.findOne({ slug });

  if (!store) {
    throw new Error(`Unknown store slug: ${slug}`);
  }

  return store.id;
}

/**
 * Prints the extraction progress, so a run that takes tens of minutes can be
 * told apart from a hung one. Every batch, not every N items: the interval
 * between lines is then a direct read on how fast the provider is answering.
 *
 * @param done - Names extracted so far.
 * @param total - Names in the run.
 */
function reportProgress(done: number, total: number): void {
  const percent = Math.floor((done / total) * 100);

  process.stdout.write(`  extracted ${done}/${total} (${percent}%)\n`);
}

/**
 * Prints a before/after sample of the computed rewrites.
 *
 * @param rewrites - The rewrites the run produced.
 */
function printSample(rewrites: NameRewrite[]): void {
  rewrites.slice(0, SAMPLE_SIZE).forEach((rewrite) => {
    process.stdout.write(
      `  ${rewrite.nameOrig}\n`
        + `    ${rewrite.before ?? '<null>'} -> ${rewrite.after ?? '<null>'}\n`,
    );
  });
}

/**
 * Recomputes `product.name` for the whole catalogue (or one store) from the
 * raw scraped name: the LLM extracts brand + expression, and
 * `ProductNameUtils.clean` is the fallback for anything it cannot resolve.
 * Idempotent — rows whose name already matches are left untouched.
 *
 * NB: manual name edits are indistinguishable from scraped ones and are
 * overwritten by this run.
 *
 * @returns The process exit code.
 */
async function main(): Promise<number> {
  const options = parseArgs();

  if (options.store !== undefined && !options.store) {
    process.stderr.write(
      'Usage: clean-product-names [--dry-run] [--no-llm] [--store <slug>]\n',
    );

    return 1;
  }

  initializeTransactionalContext();

  const app = await NestFactory.createApplicationContext(CleanNamesModule, {
    logger: ['error', 'warn'],
  });

  try {
    const products = app.get(CoreProductService);
    const stores = app.get(CoreStoreService);
    const llmNames = app.get(LlmNameExtractionService);

    const storeId = await resolveStoreId(stores, options.store);
    const all = await products.findMany();
    const rows = storeId
      ? all.filter((row) => row.storeId === storeId)
      : all;

    /**
     * `collapseTags` and `canonicalSpelling` weigh a name against the whole
     * catalogue, so a `--store` run has to see the other stores too — through
     * the names already stored for them, which a previous run produced.
     * Deriving the evidence from the store alone let a one-store run undo what
     * a catalogue-wide run had decided.
     */
    const context: (string | null)[] = storeId
      ? all.filter((row) => row.storeId !== storeId)
        .map((row) => row.name ?? null)
      : [];

    process.stdout.write(
      `Loaded ${rows.length} products`
        + (storeId ? ` (of ${all.length} in the catalogue)` : '')
        + '\n',
    );

    /**
     * One candidate per **distinct** source name, not per row. Two things
     * depend on this: the same source name can no longer come back cleaned two
     * different ways (it used to, in 66 cases, because the rows landed in
     * different chunks), and a catalogue of 6 981 rows collapses to 4 862
     * calls' worth of lines. Sorting groups a brand's variants into the same
     * chunk, so the model judges a family together rather than piecemeal.
     */
    const candidates = new Map<string, LlmNameCandidate>();

    for (
      const row of [...rows].sort((a, b) =>
        a.nameOrig.localeCompare(b.nameOrig)
      )
    ) {
      if (!candidates.has(row.nameOrig)) {
        candidates.set(row.nameOrig, { name: row.nameOrig });
      }
    }

    const useLlm = !options.noLlm && llmNames.enabled;

    process.stdout.write(
      `${candidates.size} distinct source name(s)\n`,
    );

    if (useLlm) {
      process.stdout.write(
        `Running LLM name extraction over ${candidates.size} name(s)`
          + ` in ${Math.ceil(candidates.size / LLM_CHUNK_SIZE)} batch(es)\n`,
      );

      await llmNames.extractNames(
        [...candidates.values()],
        (done, total) => reportProgress(done, total),
      );
    } else {
      process.stdout.write(
        'LLM pass skipped — deterministic cleanup only\n',
      );
    }

    let llmOk = 0;
    let llmFallback = 0;
    let blank = 0;
    const rewrites: NameRewrite[] = [];

    const resolved = rows.map((row) => {
      const extracted = candidates.get(row.nameOrig)?.cleanName ?? null;

      if (useLlm && extracted) {
        llmOk += 1;
      } else if (useLlm) {
        llmFallback += 1;
      }

      const name = extracted ?? ProductNameUtils.clean(row.nameOrig);

      if (name === null) {
        blank += 1;
      }

      return name;
    });

    const tags = collapseTags([...resolved, ...context]);
    const collapsed = resolved.map((name) =>
      name === null ? null : tags.get(name) ?? name
    );

    const spelling = canonicalSpelling([...collapsed, ...context]);

    rows.forEach((row, index) => {
      const name = collapsed[index];
      const after = name === null
        ? null
        : spelling.get(spellingKey(name)) ?? name;

      const before = row.name ?? null;

      if (after !== before) {
        rewrites.push({
          id: row.id,
          nameOrig: row.nameOrig,
          before,
          after,
        });
      }
    });

    process.stdout.write(
      `total=${rows.length} changed=${rewrites.length} `
        + `unchanged=${rows.length - rewrites.length} `
        + `llmOk=${llmOk} llmFallback=${llmFallback} blank=${blank}\n`,
    );

    printSample(rewrites);

    if (options.dryRun) {
      process.stdout.write('Dry run — nothing written\n');

      return 0;
    }

    let written = 0;

    for (const rewrite of rewrites) {
      /**
       * `never` mirrors `ProductService.update`: the entity types `name` as
       * optional, so a deliberate `null` (nothing meaningful left in the raw
       * name) does not fit `EntityUpdateInputBase`.
       */
      await products.update(rewrite.id, { name: rewrite.after } as never);

      written += 1;

      if (written % PROGRESS_EVERY === 0) {
        process.stdout.write(`  written ${written}/${rewrites.length}\n`);
      }
    }

    process.stdout.write(`Updated ${written} products\n`);

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
