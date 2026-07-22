import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

import { CurrentUser, Permission } from '~decorators/auth';
import { Paginated, Plain } from '~decorators/types';
import { ByIdDto } from '~domain/common/dto';
import { Action, Resource } from '~enums';
import type { CtxManager, CtxUser, EntityUser, TypePaginated } from '~types';
import {
  UserChangePasswordInputDto,
  UserCreateInputDto,
  UserIdParamDto,
  UserUpdateInputDto,
} from './dto';

import { DomainUserService } from './domain-user.service';
import { UserPublicType } from './types';

const isSelf = (ctx: CtxManager): boolean => {
  const { params } = ctx.getData<{ params: { id?: number } }>();

  return !!ctx.user && ctx.user.id.toString() === params.id?.toString();
};

const isSelfPassword = (ctx: CtxManager): boolean => {
  const { params } = ctx.getData<{ params: { userId?: string } }>();

  return !!ctx.user &&
    (!params.userId || ctx.user.id.toString() === params.userId);
};

@Controller('user')
export class UserController {
  public constructor(private readonly userService: DomainUserService) {}

  @Get()
  @Paginated(UserPublicType, Resource.USER, Action.LIST)
  public async list(): Promise<TypePaginated<EntityUser>> {
    return this.userService.list({});
  }

  @Get(':id')
  @Plain(UserPublicType, Resource.USER, Action.READ)
  public async get(
    @Param() params: ByIdDto,
  ): Promise<EntityUser> {
    return this.userService.get(params.id);
  }

  @Post()
  @Plain(UserPublicType, Resource.USER, Action.CREATE)
  public async create(
    @Body() data: UserCreateInputDto,
  ): Promise<EntityUser> {
    return this.userService.create(data);
  }

  @Delete(':id')
  @Permission(Resource.USER, Action.DELETE)
  public async delete(@Param() params: ByIdDto): Promise<void> {
    await this.userService.delete(params.id);
  }

  @Patch(':id')
  @Plain(
    UserPublicType,
    [Resource.USER, Action.UPDATE],
    [Resource.SELF, isSelf],
  )
  public async update(
    @Param() { id }: ByIdDto,
    @Body() data: UserUpdateInputDto,
  ): Promise<EntityUser> {
    return this.userService.update(id, data);
  }

  @Post('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permission(
    [Resource.USER, Action.UPDATE],
    [Resource.SELF, isSelfPassword],
  )
  public async changeOwnPassword(
    @CurrentUser() user: CtxUser,
    @Body() data: UserChangePasswordInputDto,
  ): Promise<void> {
    await this.userService.changePassword(data, user);
  }

  @Post('password/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permission(
    [Resource.USER, Action.UPDATE],
    [Resource.SELF, isSelfPassword],
  )
  public async changeUserPassword(
    @CurrentUser() user: CtxUser,
    @Param() { userId }: UserIdParamDto,
    @Body() data: UserChangePasswordInputDto,
  ): Promise<void> {
    await this.userService.changePassword(data, user, userId);
  }
}
