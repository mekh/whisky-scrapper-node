import {
  MiddlewareConsumer,
  Module,
  NestModule,
  ValidationPipe,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ClsMiddleware } from 'nestjs-cls';
import { DataSource, DataSourceOptions } from 'typeorm';
import {
  addTransactionalDataSource,
  getDataSourceByName,
} from 'typeorm-transactional';

import { ConfigModule, DbConfig, ValidationConfig } from '~config';
import { DomainAuthModule } from '~domain/auth';
import { DomainMetaModule } from '~domain/meta';
import { DomainProductModule } from '~domain/product';
import { DomainReportModule } from '~domain/report';
import { DomainStoreModule } from '~domain/store';
import { DomainUserModule } from '~domain/user';
import { ServerError } from '~errors';
import { LoggerModule } from '~lib/logger';

import { ContextModule } from './context';
import { ExceptionFilter } from './filters';
import { AuthJwtGuard, PermissionGuard } from './guards';
import { LogInterceptor, ValidationInterceptor } from './interceptors';

@Module({
  imports: [
    ContextModule,
    LoggerModule,
    TypeOrmModule.forRootAsync({
      imports: [
        ConfigModule,
      ],
      inject: [
        DbConfig,
      ],
      useFactory: (config: DbConfig): TypeOrmModuleOptions => ({ ...config }),
      dataSourceFactory: async (
        options?: DataSourceOptions,
      ): Promise<DataSource> => {
        if (!options) {
          throw new ServerError('Missing TypeORM data source options');
        }

        return getDataSourceByName('default')
          ?? addTransactionalDataSource(new DataSource(options));
      },
    }),
    DomainUserModule,
    DomainAuthModule,
    DomainReportModule,
    DomainMetaModule,
    DomainStoreModule,
    DomainProductModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: AuthJwtGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: LogInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ValidationInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: ExceptionFilter,
    },
    {
      provide: APP_PIPE,
      inject: [
        ValidationConfig,
      ],
      useFactory: (config: ValidationConfig): ValidationPipe =>
        new ValidationPipe(config.validationPipeOptions),
    },
    ValidationConfig,
  ],
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ClsMiddleware).forRoutes('*');
  }
}
