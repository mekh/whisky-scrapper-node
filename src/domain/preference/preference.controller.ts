import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';

import { CurrentUser } from '~decorators/auth';
import { CacheControl } from '~decorators/http';
import { Plain } from '~decorators/types';
import { ByUserIdDto } from '~domain/common/dto';
import { Action, Resource } from '~enums';
import type { CtxManager, CtxUser, Preference } from '~types';

import { PreferenceBlacklistDto, PreferenceFavoritesDto } from './dto';
import { PreferenceService } from './preference.service';
import { PreferenceType } from './preference.type.dto';

const isSelf = (ctx: CtxManager): boolean => {
  const { params } = ctx.getData<{ params: { userId?: string } }>();

  return !!ctx.user &&
    (!params.userId || ctx.user.id.toString() === params.userId);
};

/**
 * Any literal route added under this controller (`GET /preference/<word>`) must
 * be declared before the `:userId` handler, or the parameter route swallows it.
 */
@Controller('preference')
export class PreferenceController {
  public constructor(private readonly preferences: PreferenceService) {}

  @Get()
  @CacheControl('no-cache')
  @Plain(PreferenceType, Resource.AUTHENTICATED)
  public own(@CurrentUser() user: CtxUser): Promise<Preference> {
    return this.preferences.getOwn(user.id);
  }

  @Get(':userId')
  @CacheControl('no-cache')
  @Plain(
    PreferenceType,
    [Resource.PREFERENCE, Action.READ],
    [Resource.SELF, isSelf],
  )
  public byUser(@Param() params: ByUserIdDto): Promise<Preference> {
    return this.preferences.getForUser(params.userId);
  }

  @Post('favorites')
  @HttpCode(HttpStatus.OK)
  @Plain(PreferenceType, Resource.AUTHENTICATED)
  public addFavorites(
    @CurrentUser() user: CtxUser,
    @Body() body: PreferenceFavoritesDto,
  ): Promise<Preference> {
    return this.preferences.addFavorites(user.id, body);
  }

  @Delete('favorites')
  @Plain(PreferenceType, Resource.AUTHENTICATED)
  public removeFavorites(
    @CurrentUser() user: CtxUser,
    @Body() body: PreferenceFavoritesDto,
  ): Promise<Preference> {
    return this.preferences.removeFavorites(user.id, body);
  }

  @Post('blacklist')
  @HttpCode(HttpStatus.OK)
  @Plain(PreferenceType, Resource.AUTHENTICATED)
  public addToBlacklist(
    @CurrentUser() user: CtxUser,
    @Body() body: PreferenceBlacklistDto,
  ): Promise<Preference> {
    return this.preferences.addToBlacklist(user.id, body);
  }

  @Delete('blacklist')
  @Plain(PreferenceType, Resource.AUTHENTICATED)
  public removeFromBlacklist(
    @CurrentUser() user: CtxUser,
    @Body() body: PreferenceBlacklistDto,
  ): Promise<Preference> {
    return this.preferences.removeFromBlacklist(user.id, body);
  }
}
