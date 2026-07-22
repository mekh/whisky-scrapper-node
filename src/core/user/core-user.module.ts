import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { CoreUserService } from './core-user.service';
import { UserRepository } from './user.repository';

/**
 * Self-contained persistence module for the `user` entity. Provides the
 * repository (internal) and exposes only {@link CoreUserService} to consumers.
 */
@Module({
  imports: [
    TypeormRepositoryModule.forFeature(UserRepository),
  ],
  providers: [
    CoreUserService,
  ],
  exports: [
    CoreUserService,
  ],
})
export class CoreUserModule {}
