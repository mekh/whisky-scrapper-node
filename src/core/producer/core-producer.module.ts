import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { CoreCountryModule } from '~core/country';

import { CoreProducerService } from './core-producer.service';
import { ProducerRepository } from './producer.repository';

/**
 * `CoreCountryModule` is imported for entity registration, not for its
 * service: `ProducerEntity` declares a string relation to `'CountryEntity'`,
 * which TypeORM resolves when the DataSource initializes, so a graph holding
 * this module without the country entity fails to boot.
 *
 * `ProducerAliasEntity`, `ProducerFlavorEntity` and `FlavorRuleEntity` stay
 * unregistered, as `ProductFlavorEntity` does: `ProducerRepository` reaches
 * them with raw SQL, and `typeorm.config.ts` still feeds them to
 * `migration:generate` through its entity glob.
 */
@Module({
  imports: [
    CoreCountryModule,
    TypeormRepositoryModule.forFeature(ProducerRepository),
  ],
  providers: [
    CoreProducerService,
  ],
  exports: [
    CoreProducerService,
  ],
})
export class CoreProducerModule {}
