import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { CoreProducerModule } from '~core/producer';

import { CoreProductService } from './core-product.service';
import { ProductRepository } from './product.repository';

/**
 * `CoreProducerModule` is imported for entity registration, not for its
 * service: `ProductEntity` declares string relations to `'ProducerEntity'`
 * (twice — the distillery and the bottler), and TypeORM resolves those when
 * the DataSource initializes.
 */
@Module({
  imports: [
    CoreProducerModule,
    TypeormRepositoryModule.forFeature(ProductRepository),
  ],
  providers: [
    CoreProductService,
  ],
  exports: [
    CoreProductService,
  ],
})
export class CoreProductModule {}
