import {
  MiddlewareConsumer,
  Module,
  NestModule,
  ValidationPipe,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ClsMiddleware } from 'nestjs-cls';
import { DataSource, DataSourceOptions } from 'typeorm';
import {
  addTransactionalDataSource,
  getDataSourceByName,
} from 'typeorm-transactional';

import { ConfigModule, DbConfig, ValidationConfig } from '~config';
import { DomainAuthModule } from '~domain/auth';
import { DomainBrandModule } from '~domain/brand';
import { DomainCollectionModule } from '~domain/collection';
import {
  DomainCurrencyCronModule,
  DomainCurrencyModule,
} from '~domain/currency';
import { DomainDashboardModule } from '~domain/dashboard';
import { DomainMetaModule } from '~domain/meta';
import { DomainPreferenceModule } from '~domain/preference';
import { DomainProductModule } from '~domain/product';
import { DomainPushModule } from '~domain/push';
import { DomainQuickFilterModule } from '~domain/quick-filter';
import { DomainReportModule } from '~domain/report';
import { DomainStoreModule } from '~domain/store';
import { DomainUserModule } from '~domain/user';
import { ServerError } from '~errors';
import { CacheModule } from '~lib/cache';
import { LoggerModule } from '~lib/logger';
import { WatchdogModule } from '~lib/watchdog';
import { ScrapeModule } from '~scrape';

import { ContextModule } from './context';
import { ExceptionFilter } from './filters';
import { AuthJwtGuard, PermissionGuard } from './guards';
import {
  LogInterceptor,
  TimeoutInterceptor,
  ValidationInterceptor,
} from './interceptors';
import { RequestDeadlineMiddleware } from './middleware';
import { RateLimitModule, UserRateLimitGuard } from './rate-limit';

@Module({
  imports: [
    ContextModule,
    ConfigModule,
    LoggerModule,
    /**
     * Registered here (it is a global module exporting `SchedulerRegistry`)
     * because scheduling is an application-wide concern; `SyncCronService` in
     * `domain/store` is its only user today.
     */
    ScheduleModule.forRoot(),
    /**
     * Per-caller request-rate limiting. Provides the guard registered below
     * and the single store that holds the live buckets.
     */
    RateLimitModule,
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
    DomainBrandModule,
    DomainCollectionModule,
    DomainCurrencyModule,
    DomainCurrencyCronModule,
    DomainDashboardModule,
    DomainReportModule,
    DomainMetaModule,
    DomainStoreModule,
    DomainProductModule,
    DomainPreferenceModule,
    DomainPushModule,
    DomainQuickFilterModule,
    ScrapeModule,
    /**
     * Registered here rather than only where it is used, because the boot
     * bump has to happen on every start: the writers it covers — the
     * migrations the deploy ran before this process existed, the
     * knowledge-base pass during startup, any script run while the app was
     * down — leave nothing behind for a lazier registration to react to.
     */
    CacheModule,
    /**
     * Last in the list on purpose: the heartbeat reads the data source and
     * the cache, so it is armed once everything it observes exists.
     */
    WatchdogModule,
  ],
  providers: [
    /**
     * Guard order is registration order, and all three of these depend on
     * it. `AuthJwtGuard` runs first because it is what puts the caller on
     * the request context; the rate limiter runs next, so its bucket is the
     * account rather than the address, and so a refused request is refused
     * before any permission work is done for it; `PermissionGuard` runs
     * last, on a request that has proven it is allowed to ask this often.
     */
    {
      provide: APP_GUARD,
      useClass: AuthJwtGuard,
    },
    {
      provide: APP_GUARD,
      useExisting: UserRateLimitGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionGuard,
    },
    /**
     * Interceptor order is execution order, and the request budget has to
     * wrap everything it is meant to bound — including logging and outgoing
     * validation — so it is registered first.
     */
    {
      provide: APP_INTERCEPTOR,
      useClass: TimeoutInterceptor,
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
  /**
   * The deadline is applied before the context middleware, and therefore
   * before every guard: it is the only hook that runs early enough to bound a
   * request that stalls in one.
   *
   * @param consumer - The middleware consumer to register on.
   */
  public configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestDeadlineMiddleware, ClsMiddleware)
      .forRoutes('*');
  }
}
