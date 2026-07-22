import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { CoreStoreService } from './core-store.service';
import { StoreRepository } from './store.repository';

@Module({
  imports: [
    TypeormRepositoryModule.forFeature(StoreRepository),
  ],
  providers: [
    CoreStoreService,
  ],
  exports: [
    CoreStoreService,
  ],
})
export class CoreStoreModule {}
