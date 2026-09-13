import { Controller, Get, Param, Query } from '@nestjs/common';

import { DEFAULT_PER_PAGE, READ_CACHE_MAX_AGE_SECONDS } from '~constants';
import { CurrentUser } from '~decorators/auth';
import { CacheControl, RateLimit, ValidateResponse } from '~decorators/http';
import { Paginated, Plain } from '~decorators/types';
import { RateLimitProfile, ReportWindow, Resource, SortOrder } from '~enums';
import type {
  CtxUser,
  PriceHistory,
  ReportFilter,
  ReportOptions,
  ReportPersonalization,
  ReportPublicGroup,
  TypePaginated,
} from '~types';

import { HistoryQueryDto, ReportKindParamsDto, ReportQueryDto } from './dto';
import { ReportService } from './report.service';
import { PriceHistoryType, ReportGroupType } from './types';

/**
 * Opted out of the outgoing DTO pipeline: the service already emits the exact
 * wire shape by naming its fields, so conversion and validation cost ~5 ms of
 * event loop a page and change nothing but the key order.
 *
 * The shape is asserted instead by `report-contract.integration.spec.ts`,
 * which is what a field added to the report SQL now has to answer to.
 */
@Controller('report')
@RateLimit(RateLimitProfile.HEAVY)
@ValidateResponse(false)
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
  ): Promise<TypePaginated<ReportPublicGroup>> {
    return this.reportService.report(
      params.kind,
      this.toFilter(query),
      this.toOptions(query),
      this.toPersonalization(query, user),
    );
  }

  private toFilter(query: ReportQueryDto): ReportFilter {
    return {
      stores: query.stores,
      minPrice: query.minPrice,
      maxPrice: query.maxPrice,
      minVolume: query.minVolume,
      maxVolume: query.maxVolume,
      flavors: query.flavors,
      excludeFlavors: query.excludeFlavors,
      types: query.types,
      countries: query.countries,
      regions: query.regions,
      excludeRegions: query.excludeRegions,
      verifiedFacts: query.verifiedFacts,
      name: query.name,
    };
  }

  private toPersonalization(
    query: ReportQueryDto,
    user: CtxUser,
  ): ReportPersonalization {
    return {
      userId: user.id,
      favoritesOnly: query.favoritesOnly,
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
