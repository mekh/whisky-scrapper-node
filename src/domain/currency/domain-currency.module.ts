import { Module } from '@nestjs/common';

import { ConfigModule } from '~config';
import { CoreCurrencyModule } from '~core/currency';

import { CurrencyController } from './currency.controller';
import {
  CurrencyConversionService,
  CurrencyRateSyncService,
  CurrencyService,
  NbuRateService,
} from './services';

@Module({
  imports: [
    ConfigModule,
    CoreCurrencyModule,
  ],
  controllers: [
    CurrencyController,
  ],
  providers: [
    CurrencyConversionService,
    CurrencyRateSyncService,
    CurrencyService,
    NbuRateService,
  ],
  exports: [
    CurrencyConversionService,
    CurrencyRateSyncService,
    CurrencyService,
  ],
})
export class DomainCurrencyModule {}
