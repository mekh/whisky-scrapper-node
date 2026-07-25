import { Module } from '@nestjs/common';

import { ConfigModule } from '~config';
import { CoreWhiskyModule } from '~core/core-whisky.module';
import { ScrapeModule } from '~scrape';

import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import { SyncOrchestratorService } from './sync-orchestrator.service';

@Module({
  imports: [
    ConfigModule,
    CoreWhiskyModule,
    ScrapeModule,
  ],
  controllers: [
    StoreController,
  ],
  providers: [
    StoreService,
    SyncOrchestratorService,
  ],
  exports: [
    SyncOrchestratorService,
  ],
})
export class DomainStoreModule {}
