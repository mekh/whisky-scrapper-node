import { Controller, Get, Query } from '@nestjs/common';

import { READ_CACHE_MAX_AGE_SECONDS } from '~constants';
import { CacheControl } from '~decorators/http';
import { Plain } from '~decorators/types';
import { Resource } from '~enums';
import type {
  DashboardBreakdown,
  DashboardMeta,
  DashboardMovers,
  DashboardSeries,
  DashboardSummary,
  DashboardSyncActivity,
} from '~types';

import { DashboardService } from './dashboard.service';
import {
  DashboardBreakdownQueryDto,
  DashboardMoversQueryDto,
  DashboardRangeQueryDto,
  DashboardSeriesQueryDto,
} from './dto';
import {
  DashboardBreakdownType,
  DashboardMetaType,
  DashboardMoversType,
  DashboardSeriesType,
  DashboardSummaryType,
  DashboardSyncActivityType,
} from './types';

@Controller('dashboard')
export class DashboardController {
  public constructor(private readonly dashboardService: DashboardService) {}

  @Get('meta')
  @CacheControl(READ_CACHE_MAX_AGE_SECONDS)
  @Plain(DashboardMetaType, Resource.AUTHENTICATED)
  public meta(): Promise<DashboardMeta> {
    return this.dashboardService.meta();
  }

  @Get('summary')
  @CacheControl(READ_CACHE_MAX_AGE_SECONDS)
  @Plain(DashboardSummaryType, Resource.AUTHENTICATED)
  public summary(
    @Query() query: DashboardRangeQueryDto,
  ): Promise<DashboardSummary> {
    return this.dashboardService.summary(query);
  }

  @Get('series')
  @CacheControl(READ_CACHE_MAX_AGE_SECONDS)
  @Plain(DashboardSeriesType, Resource.AUTHENTICATED)
  public series(
    @Query() query: DashboardSeriesQueryDto,
  ): Promise<DashboardSeries> {
    return this.dashboardService.series(query);
  }

  @Get('breakdown')
  @CacheControl(READ_CACHE_MAX_AGE_SECONDS)
  @Plain(DashboardBreakdownType, Resource.AUTHENTICATED)
  public breakdown(
    @Query() query: DashboardBreakdownQueryDto,
  ): Promise<DashboardBreakdown> {
    return this.dashboardService.breakdown(query);
  }

  @Get('movers')
  @CacheControl(READ_CACHE_MAX_AGE_SECONDS)
  @Plain(DashboardMoversType, Resource.AUTHENTICATED)
  public movers(
    @Query() query: DashboardMoversQueryDto,
  ): Promise<DashboardMovers> {
    return this.dashboardService.movers(query);
  }

  @Get('sync-activity')
  @CacheControl(READ_CACHE_MAX_AGE_SECONDS)
  @Plain(DashboardSyncActivityType, Resource.AUTHENTICATED)
  public syncActivity(
    @Query() query: DashboardRangeQueryDto,
  ): Promise<DashboardSyncActivity> {
    return this.dashboardService.syncActivity(query);
  }
}
