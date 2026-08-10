import { Module } from '@nestjs/common';

import { ConfigModule } from '~config';
import { CoreWhiskyModule } from '~core/core-whisky.module';
import { SyncFileLogModule } from '~lib/sync-file-log';
import { ScrapeModule } from '~scrape';

import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import { SyncCronService } from './sync-cron.service';
import { SyncOrchestratorService } from './sync-orchestrator.service';

@Module({
  imports: [
    ConfigModule,
    CoreWhiskyModule,
    ScrapeModule,
    SyncFileLogModule,
  ],
  controllers: [
    StoreController,
  ],
  providers: [
    StoreService,
    SyncOrchestratorService,
    SyncCronService,
  ],
  exports: [
    SyncOrchestratorService,
  ],
})
export class DomainStoreModule {}
