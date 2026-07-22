import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { CorePermissionService } from './core-permission.service';
import { PermissionRepository } from './permission.repository';

/**
 * Self-contained persistence module for the `scope` (permission) entity.
 * Provides the repository (internal) and exposes only
 * {@link CorePermissionService} to consumers.
 */
@Module({
  imports: [
    TypeormRepositoryModule.forFeature(PermissionRepository),
  ],
  providers: [
    CorePermissionService,
  ],
  exports: [
    CorePermissionService,
  ],
})
export class CorePermissionModule {}
