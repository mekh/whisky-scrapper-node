import { Module } from '@nestjs/common';

import { CoreWhiskyModule } from '~core/core-whisky.module';

import { StoreController } from './store.controller';
import { StoreService } from './store.service';

@Module({
  imports: [
    CoreWhiskyModule,
  ],
  controllers: [
    StoreController,
  ],
  providers: [
    StoreService,
  ],
})
export class DomainStoreModule {}
