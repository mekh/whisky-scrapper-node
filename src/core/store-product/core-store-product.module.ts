import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { CoreStoreProductService } from './core-store-product.service';
import { StoreProductRepository } from './store-product.repository';

@Module({
  imports: [
    TypeormRepositoryModule.forFeature(StoreProductRepository),
  ],
  providers: [
    CoreStoreProductService,
  ],
  exports: [
    CoreStoreProductService,
  ],
})
export class CoreStoreProductModule {}
