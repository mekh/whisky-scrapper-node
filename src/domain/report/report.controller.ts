import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';

import { UserThrottlerGuard } from '~app/guards/user-throttler.guard';
import { DEFAULT_PER_PAGE, READ_CACHE_MAX_AGE_SECONDS } from '~constants';
import { CurrentUser } from '~decorators/auth';
import { CacheControl } from '~decorators/http';
import { Paginated, Plain } from '~decorators/types';
import { ReportWindow, Resource, SortOrder } from '~enums';
import type {
  CtxUser,
  PriceHistory,
  ReportFilter,
  ReportGroup,
  ReportOptions,
  TypePaginated,
} from '~types';

import { HistoryQueryDto, ReportKindParamsDto, ReportQueryDto } from './dto';
import { ReportService } from './report.service';
import { PriceHistoryType, ReportGroupType } from './types';

@Controller('report')
@UseGuards(UserThrottlerGuard)
export class ReportController {
  public constructor(private readonly reportService: ReportService) {}

  @Get('history')
  @CacheControl(READ_CACHE_MAX_AGE_SECONDS)
  @Plain(PriceHistoryType, Resource.AUTHENTICATED)
  public history(@Query() query: HistoryQueryDto): Promise<PriceHistory> {
    return this.reportService.history(query.term);
  }

  @Get(':kind')
  @CacheControl(READ_CACHE_MAX_AGE_SECONDS)
  @Paginated(ReportGroupType, Resource.AUTHENTICATED)
  public report(
    @CurrentUser() user: CtxUser,
    @Param() params: ReportKindParamsDto,
    @Query() query: ReportQueryDto,
  ): Promise<TypePaginated<ReportGroup>> {
    return this.reportService.report(
      params.kind,
      this.toFilter(query, user),
      this.toOptions(query),
    );
  }

  private toFilter(query: ReportQueryDto, user: CtxUser): ReportFilter {
    return {
      userId: user.id,
      favoritesOnly: query.favoritesOnly,
      stores: query.stores,
      minPrice: query.minPrice,
      maxPrice: query.maxPrice,
      minVolume: query.minVolume,
      maxVolume: query.maxVolume,
      flavors: query.flavors,
      excludeFlavors: query.excludeFlavors,
      types: query.types,
      countries: query.countries,
      name: query.name,
    };
  }

  private toOptions(query: ReportQueryDto): ReportOptions {
    return {
      window: query.window ?? ReportWindow.WEEK,
      discountWindow: query.discountWindow,
      minDiscount: query.minDiscount,
      sort: query.sort,
      order: query.order ?? SortOrder.ASC,
      page: query.page ?? 1,
      perPage: query.perPage ?? DEFAULT_PER_PAGE,
    };
  }
}
