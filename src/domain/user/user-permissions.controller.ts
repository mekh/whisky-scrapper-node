import { Body, Controller, Get, Param, Put } from '@nestjs/common';

import { Plain } from '~decorators/types';
import { ByUserIdDto } from '~domain/common/dto';
import { Action, Resource } from '~enums';
import type { PermissionConfig, PermissionSet } from '~types';

import { DomainPermissionService } from './domain-permission.service';
import { PermissionSetInputDto } from './dto';
import { PermissionConfigType, PermissionSetType } from './types';

@Controller('user')
export class UserPermissionsController {
  public constructor(
    private readonly permissions: DomainPermissionService,
  ) {}

  @Get('config')
  @Plain(PermissionConfigType, Resource.PERMISSION, Action.READ)
  public getConfig(): PermissionConfig {
    return this.permissions.getConfig();
  }

  @Get(':userId/permissions')
  @Plain(PermissionSetType, Resource.USER, Action.READ_PERMISSIONS)
  public async get(
    @Param() { userId }: ByUserIdDto,
  ): Promise<PermissionSet> {
    return this.permissions.getForUser(userId);
  }

  @Put(':userId/permissions')
  @Plain(PermissionSetType, Resource.USER, Action.SET_PERMISSIONS)
  public async set(
    @Param() { userId }: ByUserIdDto,
    @Body() data: PermissionSetInputDto,
  ): Promise<PermissionSet> {
    return this.permissions.setForUser(userId, data);
  }
}
