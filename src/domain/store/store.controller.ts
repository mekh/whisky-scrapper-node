import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';

import { Permission } from '~decorators/auth';
import { CacheControl } from '~decorators/http';
import { Plain } from '~decorators/types';
import { Action, Resource } from '~enums';
import type {
  EntitySyncLog,
  Response,
  StoreDetail,
  StoreListItem,
  StoreSyncStatus,
} from '~types';

import {
  StoreActiveDto,
  StoreSlugParamsDto,
  StoreSyncLogParamsDto,
} from './dto';
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

  /**
   * Answers raw text, so it takes the reply over instead of going through
   * `@Plain` — the outgoing validation the type decorators install expects a
   * DTO instance and would reject a plain string.
   */
  @Get(':slug/sync-log/:id/file')
  @CacheControl('no-cache')
  @Permission([Resource.STORE, Action.READ])
  public async syncLogFile(
    @Param() params: StoreSyncLogParamsDto,
    @Res() reply: Response,
  ): Promise<void> {
    const content = await this.storeService.syncLogFile(
      params.slug,
      params.id,
    );

    await reply
      .header('Content-Type', 'text/plain; charset=utf-8')
      .send(content);
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
