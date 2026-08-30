import 'dotenv/config';
import 'reflect-metadata';

import { mkdirSync, writeFileSync } from 'node:fs';
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

/**
 * Standalone module: TypeORM and the whisky core graph. The script only reads.
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
class ExportModule {}

/**
 * Serializes rows to a TSV file in the seed's own format.
 *
 * A tab or newline inside a value is replaced rather than escaped, because the
 * importers split on tabs with no quoting — the same contract the seed files
 * already carry, and the reason a value containing one would silently shift
 * every field after it.
 *
 * @param path - Destination file.
 * @param rows - Field arrays, already ordered.
 * @returns How many rows were written.
 */
function writeTsv(path: string, rows: unknown[][]): number {
  const body = rows
    .map((row) =>
      row
        .map((field) => String(field ?? '').replace(/[\t\n]/g, ' '))
        .join('\t')
    )
    .join('\n');

  writeFileSync(path, `${body}\n`, 'utf8');

  return rows.length;
}

/**
 * Dumps the live knowledge base back into the four seed files.
 *
 * Environments drift the moment anything writes to the knowledge base at
 * runtime — a reviewer promoting a producer, `pnpm research-brands` adding a
 * brand — and those writes land in one database only. This is how they are
 * frozen: export, drop the four TSVs beside a new pair of importer migrations,
 * and every environment converges on what was reviewed.
 *
 * By default it exports only what a person or the gate has actually blessed
 * (`verified` and `auto`), because `unverified` rows are proposals and a
 * proposal is not something to ship. `--all` includes them for a full backup.
 *
 * @returns Process exit code.
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');

  const outAt = argv.indexOf('--out');

  const outDir = outAt >= 0
    ? argv[outAt + 1]
    : join('docs', 'kb-research', 'export');

  initializeTransactionalContext();

  const app = await NestFactory.createApplicationContext(ExportModule, {
    logger: ['error', 'warn'],
  });

  try {
    const dataSource = app.get(DataSource);
    const statuses = all
      ? ['verified', 'auto', 'unverified', 'rejected']
      : ['verified', 'auto'];

    mkdirSync(outDir, { recursive: true });

    const producers = await dataSource.query(
      `SELECT p.slug, p.name, p.kind, COALESCE(c.code, '') AS "countryCode",
              COALESCE(p.region, '') AS region,
              COALESCE(p."legalRegion", '') AS "legalRegion",
              COALESCE(p.owner, '') AS owner,
              COALESCE(p."defaultTypeName", '') AS "defaultTypeName",
              p."peatProfile",
              COALESCE(par.slug, '') AS "parentSlug",
              COALESCE(bot.slug, '') AS "bottlerSlug",
              p.status, COALESCE(p.confidence, '') AS confidence,
              COALESCE(p."sourceUrls", '') AS "sourceUrls",
              COALESCE(p.note, '') AS note
       FROM producer p
       LEFT JOIN country c ON c.id = p."countryId"
       LEFT JOIN producer par ON par.id = p."parentId"
       LEFT JOIN producer bot ON bot.id = p."bottlerId"
       WHERE p.status = ANY($1::text[])
       ORDER BY p.slug`,
      [statuses],
    ) as Record<string, unknown>[];

    const aliases = await dataSource.query(
      `SELECT a.key, p.slug, a.scope
       FROM producer_alias a
       JOIN producer p ON p.id = a."producerId"
       WHERE p.status = ANY($1::text[])
       ORDER BY a.key`,
      [statuses],
    ) as Record<string, unknown>[];

    const flavors = await dataSource.query(
      `SELECT p.slug, f.name, pf.effect,
              COALESCE(pf.confidence, '') AS confidence,
              COALESCE(pf."sourceUrls", '') AS "sourceUrls",
              COALESCE(pf.note, '') AS note
       FROM producer_flavor pf
       JOIN producer p ON p.id = pf."producerId"
       JOIN flavor f ON f.id = pf."flavorId"
       WHERE p.status = ANY($1::text[])
       ORDER BY p.slug, f.name`,
      [statuses],
    ) as Record<string, unknown>[];

    /**
     * Rules are exported whole, global ones included. A rule scoped to no
     * producer has no status to filter on, and the global set is precisely
     * what must not go missing — it carries the negations that let a bottling's
     * own name overrule a house profile.
     */
    const rules = await dataSource.query(
      `SELECT COALESCE(p.slug, '') AS slug, r.pattern, r."matchMode",
              COALESCE(f.name, '') AS flavor,
              COALESCE(r.effect, '') AS effect,
              COALESCE(r."peatProfile", '') AS "peatProfile",
              r.priority,
              COALESCE(r."sourceUrls", '') AS "sourceUrls",
              COALESCE(r.note, '') AS note
       FROM flavor_rule r
       LEFT JOIN producer p ON p.id = r."producerId"
       LEFT JOIN flavor f ON f.id = r."flavorId"
       ORDER BY r.priority DESC, r.pattern`,
      [],
    ) as Record<string, unknown>[];

    const counts = {
      producer: writeTsv(
        join(outDir, 'producer.tsv'),
        producers.map((row) => Object.values(row)),
      ),
      alias: writeTsv(
        join(outDir, 'alias.tsv'),
        aliases.map((row) => Object.values(row)),
      ),
      flavor: writeTsv(
        join(outDir, 'producer-flavor.tsv'),
        flavors.map((row) => Object.values(row)),
      ),
      rule: writeTsv(
        join(outDir, 'rule.tsv'),
        rules.map((row) => Object.values(row)),
      ),
    };

    console.log(`exported to ${outDir}`);
    console.log(`  producer.tsv        ${counts.producer}`);
    console.log(`  alias.tsv           ${counts.alias}`);
    console.log(`  producer-flavor.tsv ${counts.flavor}`);
    console.log(`  rule.tsv            ${counts.rule}`);
    console.log(
      all
        ? '\nincluding unverified rows (--all)'
        : '\nverified and auto rows only; pass --all for a full backup',
    );

    return 0;
  } finally {
    await app.close();
  }
}

void main().then((code) => {
  process.exitCode = code;
});
