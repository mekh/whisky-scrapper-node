import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

import { CacheControl } from '~decorators/http';
import { Plain } from '~decorators/types';
import { Action, Resource } from '~enums';
import type {
  EntitySyncLog,
  StoreDetail,
  StoreListItem,
  StoreSyncStatus,
} from '~types';

import { StoreActiveDto, StoreSlugParamsDto } from './dto';
import { StoreService } from './store.service';
import {
  StoreDetailType,
  StoreListItemType,
  StoreSyncStatusType,
  SyncLogType,
} from './types';

/**
 * `sync-status` is declared before the `:slug` routes on purpose: routes match
 * in declaration order, so the literal path has to win over the parameter.
 */
@Controller('store')
export class StoreController {
  public constructor(private readonly storeService: StoreService) {}

  @Get()
  @CacheControl('no-cache')
  @Plain([StoreListItemType], [Resource.STORE, Action.LIST])
  public list(): Promise<StoreListItem[]> {
    return this.storeService.list();
  }

  @Get('sync-status')
  @CacheControl('no-cache')
  @Plain([StoreSyncStatusType], [Resource.STORE, Action.LIST])
  public syncStatus(): Promise<StoreSyncStatus[]> {
    return this.storeService.syncStatus();
  }

  @Get(':slug')
  @CacheControl('no-cache')
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

  @Post(':slug/sync')
  @HttpCode(HttpStatus.ACCEPTED)
  @Plain(SyncLogType, [Resource.STORE, Action.SYNC])
  public sync(@Param() params: StoreSlugParamsDto): Promise<EntitySyncLog> {
    return this.storeService.sync(params.slug);
  }
}
