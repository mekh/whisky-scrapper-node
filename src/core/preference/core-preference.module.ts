import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { CorePermissionModule } from '~core/permissions';
import { CoreProductModule } from '~core/product';
import { CoreUserModule } from '~core/user';

import { CorePreferenceService } from './core-preference.service';
import { PreferenceRepository } from './preference.repository';

/**
 * The three imported core modules are here for entity registration, not for
 * their services: `forFeature` registers `FavoriteEntity`, and TypeORM resolves
 * its string relations (`'UserEntity'`, `'ProductEntity'`) when the DataSource
 * initializes. A graph holding this module without them fails to boot —
 * `CoreWhiskyModule`, which the integration tests boot on its own, carries no
 * user entity.
 *
 * `CorePermissionModule` comes along because `UserEntity` declares the inverse
 * side of the permission relation: registering the user without it leaves
 * `UserEntity#permissions` pointing at metadata that was never built.
 *
 * `BlacklistProductEntity` and `BlacklistProducerEntity` stay unregistered, as
 * `ProductFlavorEntity` does: raw SQL reaches them, and `typeorm.config.ts`
 * still feeds them to `migration:generate`.
 */
@Module({
  imports: [
    CorePermissionModule,
    CoreProductModule,
    CoreUserModule,
    TypeormRepositoryModule.forFeature(PreferenceRepository),
  ],
  providers: [
    CorePreferenceService,
  ],
  exports: [
    CorePreferenceService,
  ],
})
export class CorePreferenceModule {}
