import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { CoreCountryService } from './core-country.service';
import { CountryRepository } from './country.repository';

@Module({
  imports: [
    TypeormRepositoryModule.forFeature(CountryRepository),
  ],
  providers: [
    CoreCountryService,
  ],
  exports: [
    CoreCountryService,
  ],
})
export class CoreCountryModule {}
