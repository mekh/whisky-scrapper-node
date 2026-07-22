import { Module } from '@nestjs/common';

import { CoreBrandModule } from './brand';
import { CoreCountryModule } from './country';
import { CoreFlavorModule } from './flavor';
import { CorePriceSnapshotModule } from './price-snapshot';
import { CoreProductModule } from './product';
import { CoreStoreModule } from './store';
import { CoreStoreConfigModule } from './store-config';
import { CoreSyncLogModule } from './sync-log';
import { CoreTypeModule } from './type';

/**
 * Aggregates the whisky-domain core modules so the whole entity graph (which
 * is interconnected by relations) is registered together, and re-exports their
 * services for the domain layer to consume.
 */
@Module({
  imports: [
    CoreBrandModule,
    CoreCountryModule,
    CoreFlavorModule,
    CorePriceSnapshotModule,
    CoreProductModule,
    CoreStoreModule,
    CoreStoreConfigModule,
    CoreSyncLogModule,
    CoreTypeModule,
  ],
  exports: [
    CoreBrandModule,
    CoreCountryModule,
    CoreFlavorModule,
    CorePriceSnapshotModule,
    CoreProductModule,
    CoreStoreModule,
    CoreStoreConfigModule,
    CoreSyncLogModule,
    CoreTypeModule,
  ],
})
export class CoreWhiskyModule {}
