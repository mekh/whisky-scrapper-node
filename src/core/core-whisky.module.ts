import { Module } from '@nestjs/common';

import { CoreBrandModule } from './brand';
import { CoreCountryModule } from './country';
import { CoreFlavorModule } from './flavor';
import { CorePreferenceModule } from './preference';
import { CorePriceSnapshotModule } from './price-snapshot';
import { CoreProducerModule } from './producer';
import { CoreProductModule } from './product';
import { CorePushModule } from './push';
import { CoreQuickFilterModule } from './quick-filter';
import { CoreStoreModule } from './store';
import { CoreStoreConfigModule } from './store-config';
import { CoreStoreProductModule } from './store-product';
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
    CorePreferenceModule,
    CorePriceSnapshotModule,
    CoreProducerModule,
    CoreProductModule,
    CorePushModule,
    CoreQuickFilterModule,
    CoreStoreModule,
    CoreStoreConfigModule,
    CoreStoreProductModule,
    CoreSyncLogModule,
    CoreTypeModule,
  ],
  exports: [
    CoreBrandModule,
    CoreCountryModule,
    CoreFlavorModule,
    CorePreferenceModule,
    CorePriceSnapshotModule,
    CoreProducerModule,
    CoreProductModule,
    CorePushModule,
    CoreQuickFilterModule,
    CoreStoreModule,
    CoreStoreConfigModule,
    CoreStoreProductModule,
    CoreSyncLogModule,
    CoreTypeModule,
  ],
})
export class CoreWhiskyModule {}
