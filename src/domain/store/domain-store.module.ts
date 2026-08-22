import { Module } from '@nestjs/common';

import { ConfigModule } from '~config';
import { CoreWhiskyModule } from '~core/core-whisky.module';
import { DomainPushModule } from '~domain/push';
import { SyncFileLogModule } from '~lib/sync-file-log';
import { ScrapeModule } from '~scrape';

import { StoreController } from './store.controller';
import { StoreService } from './store.service';
import { SyncCronService } from './sync-cron.service';
import { SyncOrchestratorService } from './sync-orchestrator.service';

/**
 * `DomainPushModule` is the repo's first domain→domain import: the sync
 * orchestrator triggers the post-sync push dispatch. The dependency is
 * one-directional — `domain/push` never imports `domain/store` — so
 * `import-x/no-cycle` stays satisfied.
 */
@Module({
  imports: [
    ConfigModule,
    CoreWhiskyModule,
    DomainPushModule,
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
