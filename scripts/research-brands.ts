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
import { CoreProducerService } from '~core/producer';
import {
  KB_NAME_ALIAS_MIN_LENGTH,
  KbStatus,
  PeatProfile,
  ProducerAliasScope,
  ProducerKind,
} from '~enums';
import { LlmResearchService, ScrapeModule } from '~scrape';
import type { ResearchedProducer } from '~types';
import { KbGateUtils, KbKeyUtils } from '~utils';

import type { LlmResearchCandidate } from '../src/scrape/llm/llm.interfaces';

/**
 * How many brands one run researches unless told otherwise. Small on purpose:
 * this is the one pass whose answers become curated facts, so it is meant to
 * be run in reviewable batches rather than swept over the catalogue.
 */
const DEFAULT_LIMIT = 25;

/**
 * Standalone module: TypeORM, the whisky core graph, and the scraping engine
 * for its LLM client.
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
    ScrapeModule,
  ],
})
class ResearchModule {}

/**
 * Turns one answered candidate into the row that will be stored.
 *
 * The auto-gate is the shared one — the same policy that graded the seed's 796
 * producers — so a model's proposal is held to exactly the standard a human
 * researcher's was, no better and no worse.
 *
 * A proposal that fails the gate is **still stored**, as `unverified` with its
 * own caveats in the note. That is the whole "never pay twice" guarantee: the
 * brand now has an alias, so it never reappears as a candidate, and the answer
 * waits on the review screen instead of being bought again next month.
 *
 * @param item - The researched candidate.
 * @returns The row to store, or null when the model said nothing usable.
 */
function toProducer(item: LlmResearchCandidate): ResearchedProducer | null {
  const result = item.result;

  if (!result) {
    return null;
  }

  const gated = KbGateUtils.status({
    slug: result.slug,
    kind: result.kind,
    countryCode: result.countryCode,
    region: result.region,
    peatProfile: result.peatProfile,
    confidence: result.confidence,
    sourceUrls: result.sourceUrls,
  });

  /**
   * A withheld positive peat claim is demoted to `unknown` on the row and
   * recorded verbatim in the note. Storing it as-is would leave a claim in the
   * column that the status says to ignore — true today, and a trap the first
   * time somebody promotes the row without reading it.
   */
  const withheld = gated === KbStatus.UNVERIFIED
    && result.peatProfile !== PeatProfile.UNKNOWN
    && result.peatProfile !== PeatProfile.NONE;

  const note = [
    result.note,
    withheld ? `withheld peat proposal: ${result.peatProfile}` : '',
    `researched from brand "${item.brand}" (${item.productCount} products)`,
  ].filter(Boolean).join('. ');

  return {
    slug: result.slug,
    name: result.name,
    kind: result.kind,
    countryCode: result.countryCode,
    region: result.region,
    legalRegion: result.legalRegion,
    owner: result.owner,
    defaultTypeName: result.defaultTypeName,
    peatProfile: withheld ? PeatProfile.UNKNOWN : result.peatProfile,
    status: gated,
    confidence: result.confidence,
    sourceUrls: result.sourceUrls,
    note,
  };
}

/**
 * The row stored for a brand the model could not identify at all.
 *
 * It exists purely so the brand is never researched again. It resolves
 * nothing — `unverified` is invisible to the resolver — but it carries an
 * alias, which is what takes the brand off the candidate list.
 *
 * @param item - The unanswered candidate.
 * @returns The placeholder row.
 */
function toPlaceholder(item: LlmResearchCandidate): ResearchedProducer {
  return {
    slug: KbKeyUtils.key(item.brand).replace(/ /g, '-') || 'unknown-producer',
    name: item.brand,
    kind: ProducerKind.BLEND,
    countryCode: '',
    region: '',
    legalRegion: '',
    owner: '',
    defaultTypeName: '',
    peatProfile: PeatProfile.UNKNOWN,
    status: KbStatus.UNVERIFIED,
    confidence: 'unknown',
    sourceUrls: '',
    note: 'The research pass could not identify this brand. Stored so it is '
      + 'not researched again; a reviewer can fill it in by hand.',
  };
}

/**
 * Researches the brands the knowledge base has never seen.
 *
 * @returns Process exit code.
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const reviewOnly = argv.includes('--review');

  const limitAt = argv.indexOf('--limit');

  const limit = limitAt >= 0
    ? Number(argv[limitAt + 1]) || DEFAULT_LIMIT
    : DEFAULT_LIMIT;

  initializeTransactionalContext();

  const app = await NestFactory.createApplicationContext(ResearchModule, {
    logger: ['error', 'warn'],
  });

  try {
    const producers = app.get(CoreProducerService, { strict: false });
    const research = app.get(LlmResearchService, { strict: false });

    const brands = await producers.listUnresearchedBrands(limit);

    console.log(`${brands.length} brand(s) with no alias, worst-first`);

    brands.forEach((row) => {
      console.log(`  ${String(row.productCount).padStart(4)}  ${row.brand}`);
    });

    if (reviewOnly || !brands.length) {
      return 0;
    }

    if (!research.enabled) {
      console.error(
        'The research pass is not configured — set LLM_API_KEY and LLM_MODEL.',
      );

      return 1;
    }

    const candidates: LlmResearchCandidate[] = brands.map((row) => ({
      brand: row.brand,
      productCount: row.productCount,
      sampleNames: row.sampleNames ?? [],
    }));

    await research.research(candidates, (done, total) => {
      console.log(`  researched ${done}/${total}`);
    });

    let live = 0;
    let withheldCount = 0;
    let placeholders = 0;

    for (const item of candidates) {
      const row = toProducer(item) ?? toPlaceholder(item);

      if (!item.result) {
        placeholders += 1;
      } else if (row.status === KbStatus.AUTO) {
        live += 1;
      } else {
        withheldCount += 1;
      }

      const key = KbKeyUtils.key(item.brand);

      /**
       * A short key stays brand-scoped. Matched as a whole brand value it is
       * unambiguous; matched inside a product name it is not, and the
       * catalogue's `Elements of Islay` beside `M&H Elements` is the case that
       * settles it.
       */
      const scope = key.length >= KB_NAME_ALIAS_MIN_LENGTH
        ? ProducerAliasScope.ANY
        : ProducerAliasScope.BRAND;

      console.log(
        `  ${row.status === KbStatus.AUTO ? 'live  ' : 'held  '}`
          + `${row.slug.padEnd(28)} ${row.peatProfile.padEnd(8)}`
          + `${row.countryCode || '--'}`,
      );

      if (!dryRun) {
        await producers.saveResearched(row, key, scope);
      }
    }

    console.log(
      `\n${live} live, ${withheldCount} withheld for review, `
        + `${placeholders} unidentified`,
    );

    if (dryRun) {
      console.log('dry run — nothing was written');
    }

    return 0;
  } finally {
    await app.close();
  }
}

void main().then((code) => {
  process.exitCode = code;
});
