import { Module } from '@nestjs/common';

import { CoreWhiskyModule } from '~core/core-whisky.module';

import { CollectionStatsService } from './collection-stats.service';
import { CollectionController } from './collection.controller';
import { CollectionService } from './collection.service';

@Module({
  imports: [
    CoreWhiskyModule,
  ],
  controllers: [
    CollectionController,
  ],
  providers: [
    CollectionService,
    CollectionStatsService,
  ],
})
export class DomainCollectionModule {}
