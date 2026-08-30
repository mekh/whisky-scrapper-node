import 'dotenv/config';
import 'reflect-metadata';

import { writeFileSync } from 'node:fs';

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
import { FactSource } from '~enums';
import { KbApplyService } from '~scrape/kb/kb-apply.service';
import { KbReconcileService } from '~scrape/kb/kb-reconcile.service';
import { KbResolverService } from '~scrape/kb/kb-resolver.service';
import type { ID, KbApplyPlan, KbReconcileRow, KbResolution } from '~types';

import type { ReconcileOptions } from './reconcile-flavors.interfaces';

/**
 * The two tags the knowledge base owns outright. Every other tag it may only
 * require, forbid or offer as a baseline.
 */
const PEAT_TAGS = ['peated', 'smoky'];

/**
 * Standalone module: TypeORM plus the whisky core graph. The resolver itself
 * is constructed directly — it holds no dependencies, and pulling in
 * `ScrapeModule` would drag the HTTP clients, the browser tier and the LLM
 * configuration into a script that touches none of them.
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
  providers: [
    KbResolverService,
    KbApplyService,
    KbReconcileService,
  ],
})
class ReconcileModule {}

/**
 * Parses the command line.
 *
 * @param argv - Raw arguments, `process.argv` minus the interpreter and file.
 * @returns The options the run was asked for.
 */
function parseOptions(argv: string[]): ReconcileOptions {
  const valueOf = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);

    return at >= 0 ? argv[at + 1] : undefined;
  };

  return {
    dryRun: argv.includes('--dry-run'),
    out: valueOf('--out'),
    store: valueOf('--store'),
    brand: valueOf('--brand'),
    keepUnknownPeat: argv.includes('--keep-unknown-peat'),
    reportAttrConflicts: argv.includes('--report-attr-conflicts'),
  };
}

/**
 * Prints the dry-run report.
 *
 * What matters here is not the totals but what moved and why. Country and type
 * changes are grouped by producer because that is the unit a person can
 * actually sign off — five hundred product lines are unreadable, sixty
 * producers are not — and the peat section is split by the source that owned
 * the link, since a `legacy` link disappearing is the expected repair while a
 * `manual` one disappearing would be a defect.
 *
 * @param rows - Every candidate bottling, by id.
 * @param plan - The plan to describe.
 * @param names - Flavor id to name.
 * @param countries - Country id to code.
 * @param types - Type id to name.
 * @returns Nothing.
 */
function report(
  rows: Map<ID, KbReconcileRow>,
  plan: KbApplyPlan,
  names: Map<ID, string>,
  countries: Map<ID, string>,
  types: Map<ID, string>,
): void {
  const slugs = new Map<ID, string>();

  plan.resolutions.forEach((one) => {
    if (one.producer) {
      slugs.set(one.producer.id, one.producer.slug);
    }
  });

  const byProducer = new Map<string, string[]>();
  const peatBefore = new Map<string, number>();
  const peatAfter = new Map<string, number>();
  let producerChanges = 0;
  let factChanges = 0;
  let inserted = 0;
  let deleted = 0;

  plan.producers.forEach((write) => {
    const row = rows.get(write.productId);

    if (
      row && (row.producerId !== write.producerId
        || row.bottlerId !== write.bottlerId)
    ) {
      producerChanges += 1;
    }
  });

  plan.facts.forEach((write, at) => {
    const row = rows.get(write.productId);

    if (!row) {
      return;
    }

    const changes: string[] = [];

    if (
      write.countryId && write.countryId !== row.countryId
      && row.countrySource !== FactSource.MANUAL
    ) {
      changes.push(
        `country ${countries.get(row.countryId ?? '' as ID) ?? '-'}`
          + ` -> ${countries.get(write.countryId) ?? '?'}`
          + ` (was ${row.countrySource ?? 'none'})`,
      );
    }

    if (
      write.typeId && write.typeId !== row.typeId
      && row.typeSource !== FactSource.MANUAL
    ) {
      changes.push(
        `type ${types.get(row.typeId ?? '' as ID) ?? '-'}`
          + ` -> ${types.get(write.typeId) ?? '?'}`
          + ` (was ${row.typeSource ?? 'none'})`,
      );
    }

    if (!changes.length) {
      return;
    }

    factChanges += 1;

    const producer = slugs.get(plan.producers[at].producerId ?? ('' as ID))
      ?? '(unresolved)';

    const list = byProducer.get(producer) ?? [];

    list.push(`${row.name ?? row.id}: ${changes.join(', ')}`);
    byProducer.set(producer, list);
  });

  rows.forEach((row) => {
    row.flavors.forEach((link) => {
      if (PEAT_TAGS.includes(link.name)) {
        const key = `${link.name}:${link.source}`;

        peatBefore.set(key, (peatBefore.get(key) ?? 0) + 1);
      }
    });
  });

  plan.flavors.forEach((write) => {
    const row = rows.get(write.productId);

    inserted += write.insertFlavorIds.length;
    deleted += write.deleteFlavorIds.length;

    if (!row) {
      return;
    }

    const removed = new Set(write.deleteFlavorIds);
    const written = new Set(write.insertFlavorIds);

    /**
     * A link that is being written is counted by the insert pass below, under
     * `kb`. Counting it here as well, under the source it used to carry, is
     * what made an early report claim hundreds of surviving `llm` peat links
     * when the whole point of the pass is that none survive.
     */
    row.flavors.forEach((link) => {
      if (
        PEAT_TAGS.includes(link.name)
        && !removed.has(link.flavorId)
        && !written.has(link.flavorId)
      ) {
        const key = `${link.name}:${link.source}`;

        peatAfter.set(key, (peatAfter.get(key) ?? 0) + 1);
      }
    });

    write.insertFlavorIds.forEach((id) => {
      const name = names.get(id) ?? '?';

      if (PEAT_TAGS.includes(name)) {
        const key = `${name}:kb`;

        peatAfter.set(key, (peatAfter.get(key) ?? 0) + 1);
      }
    });
  });

  const resolved = plan.resolutions.filter((one) => one.producer).length;

  console.log(`\ngroups           ${plan.groups.length}`);
  console.log(`  resolved       ${resolved}`);
  console.log(`  unresolved     ${plan.groups.length - resolved}`);
  console.log(`bottlings        ${rows.size}`);
  console.log(`producer writes  ${producerChanges}`);
  console.log(`fact changes     ${factChanges}`);
  console.log(`flavor links +${inserted} / -${deleted}`);

  console.log('\nPEAT LINKS BY SOURCE, before -> after');

  const keys = new Set([...peatBefore.keys(), ...peatAfter.keys()]);

  [...keys].sort().forEach((key) => {
    console.log(
      `  ${key.padEnd(18)} ${peatBefore.get(key) ?? 0} -> `
        + `${peatAfter.get(key) ?? 0}`,
    );
  });

  console.log('\nPEAT DECISIONS BY REASON');

  const reasons = new Map<string, number>();

  plan.resolutions.forEach((one) => {
    const key = `${one.peatReason}/${one.peatProfile}`;

    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  });

  [...reasons.entries()].sort((left, right) => right[1] - left[1])
    .forEach(([key, count]) => console.log(`  ${key.padEnd(28)} ${count}`));

  console.log(`\nFACT CHANGES BY PRODUCER: ${byProducer.size} producers`);

  [...byProducer.entries()]
    .sort((left, right) => right[1].length - left[1].length)
    .slice(0, 30)
    .forEach(([producer, lines]) => {
      console.log(`  ${producer} (${lines.length})`);
      lines.slice(0, 3).forEach((line) => console.log(`    ${line}`));
    });
}

/**
 * Writes the per-bottling diff as a TSV, so a large change can be reviewed in
 * a spreadsheet rather than a terminal.
 *
 * @param path - Destination file.
 * @param rows - Every candidate bottling, by id.
 * @param plan - The plan to dump.
 * @param names - Flavor id to name.
 * @returns Nothing.
 */
function writeDiff(
  path: string,
  rows: Map<ID, KbReconcileRow>,
  plan: KbApplyPlan,
  names: Map<ID, string>,
): void {
  const lines = [
    'productId\tname\tbrand\tproducer\tbottler\tpeat\treason'
    + '\taddTags\tdropTags',
  ];

  const resolutionAt = new Map<ID, KbResolution>();

  plan.groups.forEach((group, at) => {
    group.rows.forEach((row) => resolutionAt.set(row.id, plan.resolutions[at]));
  });

  plan.flavors.forEach((write) => {
    const row = rows.get(write.productId);
    const resolution = resolutionAt.get(write.productId);

    if (!row || !resolution) {
      return;
    }

    if (!write.insertFlavorIds.length && !write.deleteFlavorIds.length) {
      return;
    }

    lines.push([
      row.id,
      row.name ?? '',
      row.brand ?? '',
      resolution.producer?.slug ?? '',
      resolution.bottler?.slug ?? '',
      resolution.peatProfile,
      resolution.peatReason,
      write.insertFlavorIds.map((id) => names.get(id) ?? id).join(' '),
      write.deleteFlavorIds.map((id) => names.get(id) ?? id).join(' '),
    ].join('\t'));
  });

  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');

  console.log(`\ndiff written to ${path} (${lines.length - 1} rows)`);
}

/**
 * Prints the cross-shop contradiction queue.
 *
 * It is read here rather than owned here: the log is written during a scrape,
 * because `rawAttrs` is never persisted and no later pass can reconstruct what
 * a listing claimed. This is the reconciliation run's window onto it, so a
 * reviewer signing off the diff can see which shops the disputed facts came
 * from in the first place.
 *
 * @param dataSource - The live connection.
 * @returns Resolves once the queue is printed.
 */
async function reportConflicts(dataSource: DataSource): Promise<void> {
  const rows = await dataSource.query(
    `SELECT c.attribute, st.slug AS store, count(*)::int AS rows,
            sum(c."seenCount")::int AS seen
     FROM product_fact_conflict c
     JOIN store st ON st.id = c."storeId"
     WHERE c."resolvedAt" IS NULL
     GROUP BY 1, 2
     ORDER BY 4 DESC, 3 DESC`,
  ) as { attribute: string; store: string; rows: number; seen: number }[];

  console.log(
    `\nCROSS-SHOP CONTRADICTIONS: ${rows.length} store/attribute pairs`,
  );

  if (!rows.length) {
    console.log(
      '  none logged yet — the hook runs during a scrape, so the queue fills '
        + 'after the next sync',
    );

    return;
  }

  rows.slice(0, 30).forEach((row) => {
    console.log(
      `  ${row.store.padEnd(14)} ${row.attribute.padEnd(8)} `
        + `${row.rows} products, seen ${row.seen}x`,
    );
  });
}

/**
 * Runs the reconciliation.
 *
 * @returns Resolves when the run finishes.
 */
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  initializeTransactionalContext();

  const app = await NestFactory.createApplicationContext(ReconcileModule, {
    logger: ['error', 'warn'],
  });

  try {
    const reconcile = app.get(KbReconcileService, { strict: false });
    const dataSource = app.get(DataSource);

    /**
     * The pass itself lives in `KbReconcileService`, which the review screen's
     * apply button also calls. A second copy of it here is the defect class
     * this work exists to remove — see that service's own documentation.
     */
    const run = await reconcile.run({
      dryRun: options.dryRun,
      ...(options.store === undefined ? {} : { store: options.store }),
      ...(options.brand === undefined ? {} : { brand: options.brand }),
      ...(options.keepUnknownPeat === undefined
        ? {}
        : { keepUnknownPeat: options.keepUnknownPeat }),
    });

    const byId = new Map(run.rows.map((row) => [row.id, row]));

    const flavorRows = await dataSource.query(
      'SELECT id, name FROM flavor',
    ) as { id: ID; name: string }[];

    const countryRows = await dataSource.query(
      'SELECT id, code FROM country',
    ) as { id: ID; code: string }[];

    const typeRows = await dataSource.query(
      'SELECT id, name FROM type',
    ) as { id: ID; name: string }[];

    const names = new Map(flavorRows.map((one) => [one.id, one.name]));
    const countries = new Map(countryRows.map((one) => [one.id, one.code]));
    const types = new Map(typeRows.map((one) => [one.id, one.name]));

    report(byId, run.plan, names, countries, types);

    if (options.out) {
      writeDiff(options.out, byId, run.plan, names);
    }

    if (options.reportAttrConflicts) {
      await reportConflicts(dataSource);
    }

    if (options.dryRun) {
      console.log('\ndry run — nothing was written');

      return;
    }

    console.log(
      `\napplied: ${run.summary.producerWrites} producer rows, `
        + `${run.summary.factWrites} fact rows, `
        + `${run.summary.flavorWrites} flavor rows`,
    );
  } finally {
    await app.close();
  }
}

void main();
