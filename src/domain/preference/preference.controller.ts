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
import type {
  CtxManager,
  CtxUser,
  Preference,
  PreferenceDetails,
} from '~types';

import { PreferenceBlacklistDto, PreferenceFavoritesDto } from './dto';
import { PreferenceService } from './preference.service';
import { PreferenceDetailsType, PreferenceType } from './types';

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

  @Get('details')
  @CacheControl('no-cache')
  @Plain(PreferenceDetailsType, Resource.AUTHENTICATED)
  public details(@CurrentUser() user: CtxUser): Promise<PreferenceDetails> {
    return this.preferences.getOwnDetails(user.id);
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

  @Get(':userId/details')
  @CacheControl('no-cache')
  @Plain(
    PreferenceDetailsType,
    [Resource.PREFERENCE, Action.READ],
    [Resource.SELF, isSelf],
  )
  public byUserDetails(
    @Param() params: ByUserIdDto,
  ): Promise<PreferenceDetails> {
    return this.preferences.getDetailsForUser(params.userId);
  }

  @Post(':userId/favorites')
  @HttpCode(HttpStatus.OK)
  @Plain(
    PreferenceType,
    [Resource.PREFERENCE, Action.UPDATE],
    [Resource.SELF, isSelf],
  )
  public addFavoritesForUser(
    @Param() params: ByUserIdDto,
    @Body() body: PreferenceFavoritesDto,
  ): Promise<Preference> {
    return this.preferences.addFavoritesForUser(params.userId, body);
  }

  @Delete(':userId/favorites')
  @Plain(
    PreferenceType,
    [Resource.PREFERENCE, Action.UPDATE],
    [Resource.SELF, isSelf],
  )
  public removeFavoritesForUser(
    @Param() params: ByUserIdDto,
    @Body() body: PreferenceFavoritesDto,
  ): Promise<Preference> {
    return this.preferences.removeFavoritesForUser(params.userId, body);
  }

  @Post(':userId/blacklist')
  @HttpCode(HttpStatus.OK)
  @Plain(
    PreferenceType,
    [Resource.PREFERENCE, Action.UPDATE],
    [Resource.SELF, isSelf],
  )
  public addToBlacklistForUser(
    @Param() params: ByUserIdDto,
    @Body() body: PreferenceBlacklistDto,
  ): Promise<Preference> {
    return this.preferences.addToBlacklistForUser(params.userId, body);
  }

  @Delete(':userId/blacklist')
  @Plain(
    PreferenceType,
    [Resource.PREFERENCE, Action.UPDATE],
    [Resource.SELF, isSelf],
  )
  public removeFromBlacklistForUser(
    @Param() params: ByUserIdDto,
    @Body() body: PreferenceBlacklistDto,
  ): Promise<Preference> {
    return this.preferences.removeFromBlacklistForUser(params.userId, body);
  }
}
