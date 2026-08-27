import { Module } from '@nestjs/common';

import { CoreWhiskyModule } from '~core/core-whisky.module';
import { CoreUserModule } from '~core/user';

import { QuickFilterController } from './quick-filter.controller';
import { QuickFilterService } from './quick-filter.service';

@Module({
  imports: [
    CoreWhiskyModule,
    CoreUserModule,
  ],
  controllers: [
    QuickFilterController,
  ],
  providers: [
    QuickFilterService,
  ],
})
export class DomainQuickFilterModule {}
