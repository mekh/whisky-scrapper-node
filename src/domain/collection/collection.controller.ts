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
  Query,
} from '@nestjs/common';

import { CurrentUser, Permission } from '~decorators/auth';
import { CacheControl } from '~decorators/http';
import { Plain } from '~decorators/types';
import { ByIdDto } from '~domain/common/dto';
import { Resource } from '~enums';
import type {
  CollectionIds,
  CollectionItem,
  CollectionStats,
  CtxUser,
} from '~types';

import { CollectionStatsService } from './collection-stats.service';
import { CollectionService } from './collection.service';
import {
  CollectionCreateDto,
  CollectionStatsQueryDto,
  CollectionUpdateDto,
} from './dto';
import {
  CollectionIdsType,
  CollectionItemType,
  CollectionStatsType,
} from './types';

/**
 * Literal segments (`ids`, `stats`) are declared before the `:id` parameter
 * routes, so neither can be swallowed by a route that would otherwise treat
 * the word as an id — the same discipline `/preference` and `/quick-filter`
 * follow.
 *
 * Every mutation that answers a body does so with `200`, not `201`: `@Plain`
 * documents an OK response, and a `201` would leave the created item untyped
 * in the OpenAPI schema — which is exactly how the generated client lost the
 * shape of this endpoint's answer once. Every other POST in this codebase
 * already carries `@HttpCode(HttpStatus.OK)` for the same reason.
 *
 * Unlike those two, a mutation here answers only the item it changed, never
 * the caller's whole collection: that list is hundreds of bottlings each
 * joined against its purchases and priced against every store that still
 * carries it, so re-sending it after every edit would be a page of work to
 * report a one-row change.
 *
 * Purchases have no routes of their own: `PATCH /collection/:id` carries
 * them in its `purchases` block, so the edit screen's one «save» is one
 * request and one transaction. Three per-purchase routes existed before and
 * were folded in when every client turned out to save the row and its
 * purchases together.
 */
@Controller('collection')
export class CollectionController {
  public constructor(
    private readonly collection: CollectionService,
    private readonly stats: CollectionStatsService,
  ) {}

  @Get()
  @CacheControl('no-cache')
  @Plain([CollectionItemType], Resource.AUTHENTICATED)
  public own(@CurrentUser() user: CtxUser): Promise<CollectionItem[]> {
    return this.collection.getOwn(user.id);
  }

  @Get('ids')
  @CacheControl('no-cache')
  @Plain(CollectionIdsType, Resource.AUTHENTICATED)
  public ids(@CurrentUser() user: CtxUser): Promise<CollectionIds> {
    return this.collection.getOwnIds(user.id);
  }

  @Get('stats')
  @CacheControl('no-cache')
  @Plain(CollectionStatsType, Resource.AUTHENTICATED)
  public getStats(
    @CurrentUser() user: CtxUser,
    @Query() query: CollectionStatsQueryDto,
  ): Promise<CollectionStats> {
    return this.stats.getOwn(user.id, query);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Plain(CollectionItemType, Resource.AUTHENTICATED)
  public create(
    @CurrentUser() user: CtxUser,
    @Body() body: CollectionCreateDto,
  ): Promise<CollectionItem> {
    return this.collection.create(user.id, body);
  }

  @Patch(':id')
  @Plain(CollectionItemType, Resource.AUTHENTICATED)
  public update(
    @CurrentUser() user: CtxUser,
    @Param() params: ByIdDto,
    @Body() body: CollectionUpdateDto,
  ): Promise<CollectionItem> {
    return this.collection.update(user.id, params.id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permission(Resource.AUTHENTICATED)
  public remove(
    @CurrentUser() user: CtxUser,
    @Param() params: ByIdDto,
  ): Promise<void> {
    return this.collection.remove(user.id, params.id);
  }
}
