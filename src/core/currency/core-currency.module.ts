import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { CoreCurrencyService } from './core-currency.service';
import { CurrencyRateRepository } from './currency-rate.repository';
import { CurrencyRepository } from './currency.repository';

@Module({
  imports: [
    TypeormRepositoryModule.forFeature(CurrencyRepository),
    TypeormRepositoryModule.forFeature(CurrencyRateRepository),
  ],
  providers: [
    CoreCurrencyService,
  ],
  exports: [
    CoreCurrencyService,
  ],
})
export class CoreCurrencyModule {}
