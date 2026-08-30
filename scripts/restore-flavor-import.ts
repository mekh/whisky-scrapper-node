import 'dotenv/config';
import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
import { LLM_FLAVOR_TAGS } from '~scrape/normalize/brand-info.constants';

/**
 * The classification shipped by `1786350000000-flavor-llm-import`, which is the
 * artifact of the sixteen-agent pass and the best-quality flavour data the
 * project has.
 */
const CSV = join(
  __dirname,
  '..',
  'migrations',
  '1786350000000-flavor-llm-import.csv',
);

/**
 * Standalone module: TypeORM and the whisky core graph.
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
class RestoreModule {}

/**
 * Restores the curated flavour classification over a bad `enrich-flavors` run.
 *
 * It exists because `pnpm enrich-flavors` is destructive by design —
 * `setLlmFlavors` deletes a bottling's `llm` links before writing the new
 * answer — so a run on a weak model silently replaces good data with worse.
 * That happened: a full re-pass fell back to `LLM_MODEL` because
 * `LLM_FLAVOR_MODEL` was unset, and returned the per-category templates
 * `CLAUDE.md` warns about (the largest shared tag set went from 52 names to
 * 285 products).
 *
 * **This is a local repair tool, not a migration.** The checked-in import
 * migration already put this data in every environment; production never saw
 * the bad run, so shipping a "restore" migration would re-run a no-op there and
 * imply a defect that never reached it.
 *
 * Peat is untouched throughout. `peated` and `smoky` belong to the knowledge
 * base, the CSV's rows are filtered against the thirteen tags a model may
 * state, and the bad run could not have moved them either — which is why its
 * peat counts were identical before and after.
 *
 * @returns Process exit code.
 */
async function main(): Promise<number> {
  const dryRun = process.argv.slice(2).includes('--dry-run');

  initializeTransactionalContext();

  const app = await NestFactory.createApplicationContext(RestoreModule, {
    logger: ['error', 'warn'],
  });

  try {
    const dataSource = app.get(DataSource);
    const allowed = new Set(LLM_FLAVOR_TAGS);

    const lines = readFileSync(CSV, 'utf8').split('\n').slice(1);
    const names: string[] = [];
    const pairNames: string[] = [];
    const pairTags: string[] = [];
    let dropped = 0;

    lines.forEach((line) => {
      if (!line.trim()) {
        return;
      }

      const fields = line.split(',');

      if (fields.length !== 3) {
        throw new Error(`Malformed CSV line: ${line}`);
      }

      const [name, , tags] = fields;

      names.push(name);

      tags.split('|').filter(Boolean).forEach((tag) => {
        /**
         * The CSV predates the vocabulary split, so it still carries `peated`
         * and `smoky` rows. They are dropped rather than imported: peat has
         * exactly one source of truth now, and re-importing them would break
         * the invariant this whole exercise established.
         */
        if (!allowed.has(tag)) {
          dropped += 1;

          return;
        }

        pairNames.push(name);
        pairTags.push(tag);
      });
    });

    console.log(`csv names        ${names.length}`);
    console.log(`tag links        ${pairTags.length}`);
    console.log(`peat rows droppd ${dropped}`);

    if (dryRun) {
      console.log('\ndry run — nothing was written');

      return 0;
    }

    /**
     * Only `llm` links are cleared, and only for the names being restored. A
     * `kb` link is the knowledge base's and a `manual` one is a person's;
     * neither is this script's to touch.
     */
    const deleted = await dataSource.query(
      `DELETE FROM product_flavor pf
       USING product p
       WHERE pf."productId" = p.id
         AND pf.source = 'llm'
         AND p.name = ANY($1::text[])`,
      [names],
    ) as [unknown[], number];

    await dataSource.query(
      `INSERT INTO product_flavor ("productId", "flavorId", source)
       SELECT p.id, f.id, 'llm'
       FROM unnest($1::text[], $2::text[]) AS v(name, tag)
       JOIN product p ON p.name = v.name
       JOIN flavor f ON f.name = v.tag
       ON CONFLICT ("productId", "flavorId") DO UPDATE SET source = 'llm'`,
      [pairNames, pairTags],
    );

    await dataSource.query(
      `UPDATE product SET "lastLlmFlavorAt" = now()
       WHERE name = ANY($1::text[])`,
      [names],
    );

    /**
     * Everything the CSV does not cover keeps the weak run's answer, but is
     * made a candidate again, so a later pass on a strong model re-asks about
     * exactly those and nothing else.
     */
    const reopened = await dataSource.query(
      `UPDATE product SET "lastLlmFlavorAt" = NULL
       WHERE NOT (name = ANY($1::text[]))
         AND "flavorsCuratedAt" IS NULL`,
      [names],
    ) as [unknown[], number];

    console.log(`\ncleared ${deleted[1] ?? 0} llm link(s), restored the CSV`);
    console.log(`re-opened ${reopened[1] ?? 0} bottling(s) for a later pass`);

    return 0;
  } finally {
    await app.close();
  }
}

void main().then((code) => {
  process.exitCode = code;
});
