import { Body, Controller, Get, Param, Patch } from '@nestjs/common';

import { READ_CACHE_MAX_AGE_SECONDS } from '~constants';
import { CacheControl } from '~decorators/http';
import { Plain } from '~decorators/types';
import { Action, Resource } from '~enums';
import type { StoreDetail, StoreListItem } from '~types';

import { StoreActiveDto, StoreSlugParamsDto } from './dto';
import { StoreService } from './store.service';
import { StoreDetailType, StoreListItemType } from './types';

@Controller('store')
export class StoreController {
  public constructor(private readonly storeService: StoreService) {}

  @Get()
  @CacheControl(READ_CACHE_MAX_AGE_SECONDS)
  @Plain([StoreListItemType], [Resource.STORE, Action.LIST])
  public list(): Promise<StoreListItem[]> {
    return this.storeService.list();
  }

  @Get(':slug')
  @CacheControl(READ_CACHE_MAX_AGE_SECONDS)
  @Plain(StoreDetailType, [Resource.STORE, Action.READ])
  public detail(@Param() params: StoreSlugParamsDto): Promise<StoreDetail> {
    return this.storeService.detail(params.slug);
  }

  @Patch(':slug')
  @Plain(StoreListItemType, [Resource.STORE, Action.UPDATE])
  public setActive(
    @Param() params: StoreSlugParamsDto,
    @Body() body: StoreActiveDto,
  ): Promise<StoreListItem> {
    return this.storeService.setActive(params.slug, body.active);
  }
}
