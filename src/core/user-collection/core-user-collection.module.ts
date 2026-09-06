import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { CorePermissionModule } from '~core/permissions';
import { CoreProductModule } from '~core/product';
import { CoreStoreModule } from '~core/store';
import { CoreStoreProductModule } from '~core/store-product';
import { CoreUserModule } from '~core/user';

import { CoreUserCollectionPurchaseService } from './core-user-collection-purchase.service';
import { CoreUserCollectionService } from './core-user-collection.service';
import { UserCollectionPurchaseRepository } from './user-collection-purchase.repository';
import { UserCollectionRepository } from './user-collection.repository';

/**
 * The five imported core modules are here for entity-graph registration, not
 * for their services — the `CorePreferenceModule`/`CoreQuickFilterModule`
 * precedent: `forFeature` registers `UserCollectionEntity` and
 * `UserCollectionPurchaseEntity`, and TypeORM resolves their string relations
 * (`'UserEntity'`, `'ProductEntity'`, `'StoreEntity'`, `'StoreProductEntity'`,
 * and `UserCollectionPurchaseEntity`'s own `'UserCollectionEntity'`) when the
 * DataSource initializes. `CorePermissionModule` comes along because
 * `UserEntity` declares the inverse side of the permission relation, so
 * registering the user without it leaves that metadata unbuilt.
 */
@Module({
  imports: [
    CorePermissionModule,
    CoreUserModule,
    CoreProductModule,
    CoreStoreModule,
    CoreStoreProductModule,
    TypeormRepositoryModule.forFeature([
      UserCollectionRepository,
      UserCollectionPurchaseRepository,
    ]),
  ],
  providers: [
    CoreUserCollectionService,
    CoreUserCollectionPurchaseService,
  ],
  exports: [
    CoreUserCollectionService,
    CoreUserCollectionPurchaseService,
  ],
})
export class CoreUserCollectionModule {}
