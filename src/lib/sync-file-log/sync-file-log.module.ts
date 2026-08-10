import { Module } from '@nestjs/common';

import { ConfigModule } from '~config';

import { SyncFileLogService } from './sync-file-log.service';

@Module({
  imports: [
    ConfigModule,
  ],
  providers: [
    SyncFileLogService,
  ],
  exports: [
    SyncFileLogService,
  ],
})
export class SyncFileLogModule {}
