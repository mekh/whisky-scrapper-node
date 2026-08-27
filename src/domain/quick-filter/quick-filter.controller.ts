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

import { CurrentUser } from '~decorators/auth';
import { CacheControl } from '~decorators/http';
import { Plain } from '~decorators/types';
import { ByIdDto, ByUserIdDto } from '~domain/common/dto';
import { Action, Resource } from '~enums';
import type { CtxManager, CtxUser, QuickFilter } from '~types';

import { QuickFilterCreateDto, QuickFilterUpdateDto } from './dto';
import { QuickFilterService } from './quick-filter.service';
import { QuickFilterType } from './quick-filter.type.dto';

const isSelf = (ctx: CtxManager): boolean => {
  const { params } = ctx.getData<{ params: { userId?: string } }>();

  return !!ctx.user
    && (!params.userId || ctx.user.id.toString() === params.userId);
};

/**
 * Every mutation answers the caller's whole list, so a client replaces its
 * cached copy from the response and never needs a follow-up read.
 *
 * The `user/:userId` route is declared before the `:id` ones. Its literal
 * segment sits one level deeper so no collision is possible today, but the
 * `PreferenceController` discipline holds: a literal route goes above the
 * parameter route that could otherwise swallow it.
 */
@Controller('quick-filter')
export class QuickFilterController {
  public constructor(private readonly quickFilters: QuickFilterService) {}

  @Get()
  @CacheControl('no-cache')
  @Plain([QuickFilterType], Resource.AUTHENTICATED)
  public own(@CurrentUser() user: CtxUser): Promise<QuickFilter[]> {
    return this.quickFilters.getOwn(user.id);
  }

  @Get('user/:userId')
  @CacheControl('no-cache')
  @Plain(
    [QuickFilterType],
    [Resource.QUICK_FILTER, Action.READ],
    [Resource.SELF, isSelf],
  )
  public byUser(@Param() params: ByUserIdDto): Promise<QuickFilter[]> {
    return this.quickFilters.getForUser(params.userId);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Plain([QuickFilterType], Resource.AUTHENTICATED)
  public create(
    @CurrentUser() user: CtxUser,
    @Body() body: QuickFilterCreateDto,
  ): Promise<QuickFilter[]> {
    return this.quickFilters.create(user.id, body);
  }

  @Patch(':id')
  @Plain([QuickFilterType], Resource.AUTHENTICATED)
  public update(
    @CurrentUser() user: CtxUser,
    @Param() params: ByIdDto,
    @Body() body: QuickFilterUpdateDto,
  ): Promise<QuickFilter[]> {
    return this.quickFilters.update(user.id, params.id, body);
  }

  @Delete(':id')
  @Plain([QuickFilterType], Resource.AUTHENTICATED)
  public remove(
    @CurrentUser() user: CtxUser,
    @Param() params: ByIdDto,
  ): Promise<QuickFilter[]> {
    return this.quickFilters.remove(user.id, params.id);
  }
}
