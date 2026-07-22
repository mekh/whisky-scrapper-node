import { Module } from '@nestjs/common';

import { CorePermissionModule } from '~core/permissions';
import { CoreUserModule } from '~core/user';

import { DomainPermissionService } from './domain-permission.service';
import { DomainUserService } from './domain-user.service';
import { UserPermissionsController } from './user-permissions.controller';
import { UserController } from './user.controller';

/**
 * Feature module wiring the user REST controllers to their business services,
 * which in turn depend on the core persistence modules.
 */
@Module({
  imports: [
    CoreUserModule,
    CorePermissionModule,
  ],
  controllers: [
    UserController,
    UserPermissionsController,
  ],
  providers: [
    DomainUserService,
    DomainPermissionService,
  ],
})
export class DomainUserModule {}
