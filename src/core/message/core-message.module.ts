import { Module } from '@nestjs/common';
import { TypeormRepositoryModule } from '@toxicoder/nestjs-typeorm-repository';

import { CorePermissionModule } from '~core/permissions';
import { CoreUserModule } from '~core/user';

import { CoreMessageService } from './core-message.service';
import { MessageRepository } from './message.repository';

/**
 * The imported core modules are here for entity registration, not for their
 * services — the `CorePushModule` precedent: `forFeature` registers
 * `MessageEntity`, and TypeORM resolves its string relation (`'UserEntity'`)
 * when the DataSource initializes. `CorePermissionModule` comes along because
 * `UserEntity` declares the inverse side of the permission relation.
 *
 * `MessageRecipientEntity` stays unregistered, as the blacklist entities do:
 * raw SQL reaches it, and `typeorm.config.ts` still feeds it to
 * `migration:generate`.
 */
@Module({
  imports: [
    CorePermissionModule,
    CoreUserModule,
    TypeormRepositoryModule.forFeature(MessageRepository),
  ],
  providers: [
    CoreMessageService,
  ],
  exports: [
    CoreMessageService,
  ],
})
export class CoreMessageModule {}
