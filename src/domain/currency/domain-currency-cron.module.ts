import { Module } from '@nestjs/common';

import { ConfigModule } from '~config';

import { DomainCurrencyModule } from './domain-currency.module';
import { CurrencyRateCronService } from './services';

/**
 * The scheduled half of the currency feature, kept in a module of its own.
 *
 * `CurrencyRateCronService` injects `SchedulerRegistry`, which only exists
 * where `ScheduleModule.forRoot()` has been registered — that is, in the HTTP
 * application. Leaving it inside `DomainCurrencyModule` would make that module
 * unusable from a CLI script (`pnpm rates` bootstraps a bare application
 * context), and the alternatives are worse: registering `ScheduleModule` in
 * the script would arm a job that could tick in the middle of a multi-minute
 * backfill, and making the registry optional would let a misconfigured
 * deployment silently never sync.
 *
 * So the split is the boundary it looks like: everything a script can use is
 * in `DomainCurrencyModule`, and everything that needs a running scheduler is
 * here.
 */
@Module({
  imports: [
    ConfigModule,
    DomainCurrencyModule,
  ],
  providers: [
    CurrencyRateCronService,
  ],
})
export class DomainCurrencyCronModule {}
