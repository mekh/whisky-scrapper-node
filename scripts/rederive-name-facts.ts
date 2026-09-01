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
import { CoreCountryService } from '~core/country';
import { CoreProductService } from '~core/product';
import { CoreTypeService } from '~core/type';
import { FactSource } from '~enums';
import { NormalizeService } from '~scrape/normalize/normalize.service';
import type { ID, ProductFillInput } from '~types';

import type { RederiveRow } from './rederive-name-facts.interfaces';

/**
 * Standalone module: TypeORM and the whisky core graph. `NormalizeService`
 * holds no dependencies and is constructed directly rather than dragging the
 * whole scraping engine in.
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
class RederiveModule {}

/**
 * Re-derives whisky type and country from the raw listing names, deterministic-
 * ally, and stamps what it writes as `name`.
 *
 * It exists because of the ordering problem the strict filter rule creates. The
 * rule sends every `llm` and `legacy` value into the filter's `unknown` bucket
 * — which is right, since neither is evidence anyone checked — but on the day
 * it is switched on nearly the whole catalogue is still `legacy`, so the type
 * and country filters would answer with almost nothing. The knowledge base
 * closed most of that gap; this closes the rest that is closeable without a
 * scrape, by reading what the store's own name already says.
 *
 * The keywords are the same ones the live pipeline uses (`TYPE_KEYWORDS`,
 * `COUNTRY_KEYWORDS`), so a value derived here is indistinguishable from one a
 * sync would derive — which is what makes stamping it `name` honest rather
 * than flattering.
 *
 * It never touches a value that outranks `name`: `kb`, `manual` and `store` are
 * all better evidence than a keyword in a title, and `fillMissing` is
 * rank-aware for exactly this reason.
 *
 * @returns Process exit code.
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');

  initializeTransactionalContext();

  const app = await NestFactory.createApplicationContext(RederiveModule, {
    logger: ['error', 'warn'],
  });

  try {
    const dataSource = app.get(DataSource);
    const products = app.get(CoreProductService, { strict: false });
    const types = app.get(CoreTypeService, { strict: false });
    const countries = app.get(CoreCountryService, { strict: false });
    const normalize = new NormalizeService();

    /**
     * Only the rows the rule would otherwise send to `unknown`, and only where
     * the raw name exists to read. The longest raw name wins for the same
     * reason the flavour pass picks it: it carries the most descriptors.
     */
    const rows = await dataSource.query(
      `SELECT p.id, o."nameOrig" AS "nameOrig",
              p."typeId", p."typeSource",
              p."countryId", p."countrySource"
       FROM product p
       JOIN LATERAL (
         SELECT sp."nameOrig"
         FROM store_product sp
         WHERE sp."productId" = p.id
         ORDER BY length(sp."nameOrig") DESC, sp."lastSeen" DESC, sp.id
         LIMIT 1
       ) o ON true
       WHERE (p."typeSource" IS NULL OR p."typeSource" IN ($1, $2))
          OR (p."countrySource" IS NULL OR p."countrySource" IN ($1, $2))`,
      [FactSource.LEGACY, FactSource.LLM],
    ) as RederiveRow[];

    const typeNames = new Set<string>();
    const countryNames = new Set<string>();
    const found: {
      row: RederiveRow;
      type: string | null;
      country: string | null;
    }[] = [];

    rows.forEach((row) => {
      const type = normalize.extractType(row.nameOrig);

      const country = normalize.canonicalCountry(
        normalize.extractCountry(row.nameOrig),
      );

      if (!type && !country) {
        return;
      }

      if (type) {
        typeNames.add(type);
      }

      if (country) {
        countryNames.add(country);
      }

      found.push({ row, type, country });
    });

    const typeIds = await types.resolveByName([...typeNames]);
    const countryIds = await countries.resolveByNameUa([...countryNames]);

    const fills: ProductFillInput[] = [];
    let typeWrites = 0;
    let countryWrites = 0;
    let typeChanges = 0;
    let countryChanges = 0;

    found.forEach(({ row, type, country }) => {
      const typeId = type ? typeIds.get(type) ?? null : null;

      const countryId = country
        ? countryIds.get(country.trim().toLowerCase()) ?? null
        : null;

      /**
       * A value that already matches is still written, and that is the point.
       * Most of these rows hold the right type already and hold it as
       * `legacy` — a source that states "nobody knows where this came from",
       * which is exactly what the strict filter rule sends to the `unknown`
       * bucket. Re-stamping it `name` says something true and testable: the
       * listing's own words spell this type out, and today's pipeline would
       * derive it. `fillMissing` is rank-aware, so the write only ever
       * promotes a lower-ranked source and never overwrites `store`, `kb` or
       * `manual`.
       */
      const writeType = Boolean(typeId);
      const writeCountry = Boolean(countryId);

      if (!writeType && !writeCountry) {
        return;
      }

      typeChanges += writeType && typeId !== row.typeId ? 1 : 0;
      countryChanges += writeCountry && countryId !== row.countryId ? 1 : 0;
      typeWrites += writeType ? 1 : 0;
      countryWrites += writeCountry ? 1 : 0;

      fills.push({
        id: row.id as ID,
        abv: null,
        typeId: writeType ? typeId : null,
        countryId: writeCountry ? countryId : null,
        brandOrig: null,
        abvSource: FactSource.NAME,
        typeSource: FactSource.NAME,
        countrySource: FactSource.NAME,
      });
    });

    console.log(`candidates       ${rows.length}`);
    console.log(`with a keyword   ${found.length}`);
    console.log(`type re-stamps   ${typeWrites} (${typeChanges} change value)`);
    console.log(
      `country re-stamps ${countryWrites} (${countryChanges} change value)`,
    );

    if (dryRun) {
      console.log('\ndry run — nothing was written');

      return 0;
    }

    const changed = await products.fillMissing(fills);

    console.log(`\napplied to ${changed} bottling(s)`);

    return 0;
  } finally {
    await app.close();
  }
}

void main().then((code) => {
  process.exitCode = code;
});
