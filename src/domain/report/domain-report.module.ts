import { Module } from '@nestjs/common';

import { CoreWhiskyModule } from '~core/core-whisky.module';
import { CacheModule } from '~lib/cache';

import { ReportController } from './report.controller';
import { ReportService } from './report.service';

@Module({
  imports: [
    CacheModule,
    CoreWhiskyModule,
  ],
  controllers: [
    ReportController,
  ],
  providers: [
    ReportService,
  ],
})
export class DomainReportModule {}
