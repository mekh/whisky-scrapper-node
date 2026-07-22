import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { CoreStoreConfigService } from './core-store-config.service';
import { StoreConfigRepository } from './store-config.repository';

@Module({
  imports: [
    TypeormRepositoryModule.forFeature(StoreConfigRepository),
  ],
  providers: [
    CoreStoreConfigService,
  ],
  exports: [
    CoreStoreConfigService,
  ],
})
export class CoreStoreConfigModule {}
