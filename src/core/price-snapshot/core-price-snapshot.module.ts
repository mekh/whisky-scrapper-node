import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { CorePriceSnapshotService } from './core-price-snapshot.service';
import { PriceSnapshotRepository } from './price-snapshot.repository';

@Module({
  imports: [
    TypeormRepositoryModule.forFeature(PriceSnapshotRepository),
  ],
  providers: [
    CorePriceSnapshotService,
  ],
  exports: [
    CorePriceSnapshotService,
  ],
})
export class CorePriceSnapshotModule {}
