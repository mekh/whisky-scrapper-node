import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { CorePermissionModule } from '~core/permissions';
import { CoreUserModule } from '~core/user';

import { CoreQuickFilterService } from './core-quick-filter.service';
import { QuickFilterRepository } from './quick-filter.repository';

/**
 * The two imported core modules are here for entity registration, not for
 * their services — the `CorePreferenceModule` precedent: `forFeature`
 * registers `QuickFilterEntity`, and TypeORM resolves its string relation
 * (`'UserEntity'`) when the DataSource initializes. `CorePermissionModule`
 * comes along because `UserEntity` declares the inverse side of the permission
 * relation, so registering the user without it leaves that metadata unbuilt.
 */
@Module({
  imports: [
    CorePermissionModule,
    CoreUserModule,
    TypeormRepositoryModule.forFeature(QuickFilterRepository),
  ],
  providers: [
    CoreQuickFilterService,
  ],
  exports: [
    CoreQuickFilterService,
  ],
})
export class CoreQuickFilterModule {}
