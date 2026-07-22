import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { CoreProductService } from './core-product.service';
import { ProductRepository } from './product.repository';

@Module({
  imports: [
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
