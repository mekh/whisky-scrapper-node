import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { CorePermissionModule } from '~core/permissions';
import { CoreStoreProductModule } from '~core/store-product';
import { CoreUserModule } from '~core/user';

import { CorePushService } from './core-push.service';
import { PushRepository } from './push.repository';

/**
 * The imported core modules are here for entity registration, not for their
 * services — the `CorePreferenceModule` precedent: `forFeature` registers
 * `PushSubscriptionEntity`, and TypeORM resolves its string relation
 * (`'UserEntity'`) when the DataSource initializes. `CorePermissionModule`
 * comes along because `UserEntity` declares the inverse side of the
 * permission relation, and `CoreStoreProductModule` because
 * `PushDigestLogEntity` relates to `'StoreProductEntity'`.
 *
 * `PushDigestLogEntity` itself stays unregistered, as the blacklist entities
 * do: raw SQL reaches it, and `typeorm.config.ts` still feeds it to
 * `migration:generate`.
 */
@Module({
  imports: [
    CorePermissionModule,
    CoreStoreProductModule,
    CoreUserModule,
    TypeormRepositoryModule.forFeature(PushRepository),
  ],
  providers: [
    CorePushService,
  ],
  exports: [
    CorePushService,
  ],
})
export class CorePushModule {}
