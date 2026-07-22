import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { CoreSyncLogService } from './core-sync-log.service';
import { SyncLogRepository } from './sync-log.repository';

@Module({
  imports: [
    TypeormRepositoryModule.forFeature(SyncLogRepository),
  ],
  providers: [
    CoreSyncLogService,
  ],
  exports: [
    CoreSyncLogService,
  ],
})
export class CoreSyncLogModule {}
