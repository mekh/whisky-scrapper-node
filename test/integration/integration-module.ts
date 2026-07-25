import 'dotenv/config';
import 'reflect-metadata';

import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, DataSourceOptions } from 'typeorm';
import {
  addTransactionalDataSource,
  deleteDataSourceByName,
  getDataSourceByName,
  initializeTransactionalContext,
} from 'typeorm-transactional';

import { ConfigModule, DbConfig } from '~config';
import { CoreWhiskyModule } from '~core/core-whisky.module';

let contextReady = false;

/**
 * Boots a Nest module wired to the real dev database (the same TypeORM +
 * typeorm-transactional setup as the app), with the whole whisky core graph
 * available. Integration tests resolve core services from the returned module
 * and run against a live Postgres.
 *
 * @returns The compiled testing module.
 */
export async function bootIntegrationModule(): Promise<TestingModule> {
  if (!contextReady) {
    initializeTransactionalContext();

    contextReady = true;
  }

  return Test.createTestingModule({
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
  }).compile();
}

/**
 * Closes the module and drops the transactional data-source registration, so a
 * later boot in another spec file starts from a clean slate.
 *
 * @param moduleRef - The module returned by {@link bootIntegrationModule}.
 * @returns Resolves once the module is closed.
 */
export async function closeIntegrationModule(
  moduleRef: TestingModule,
): Promise<void> {
  await moduleRef.close();

  deleteDataSourceByName('default');
}
