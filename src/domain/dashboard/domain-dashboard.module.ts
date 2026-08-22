import { Module } from '@nestjs/common';

import { CoreWhiskyModule } from '~core/core-whisky.module';

import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [
    CoreWhiskyModule,
  ],
  controllers: [
    DashboardController,
  ],
  providers: [
    DashboardService,
  ],
})
export class DomainDashboardModule {}
