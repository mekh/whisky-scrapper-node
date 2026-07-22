import { Controller, Get, Param, Query } from '@nestjs/common';

import { DEFAULT_PER_PAGE } from '~constants';
import { Paginated, Plain } from '~decorators/types';
import { ReportWindow, Resource, SortOrder } from '~enums';
import type {
  PriceHistory,
  ReportFilter,
  ReportOptions,
  ReportRow,
  TypePaginated,
} from '~types';

import { HistoryQueryDto, ReportKindParamsDto, ReportQueryDto } from './dto';
import { ReportService } from './report.service';
import { PriceHistoryType, ReportRowType } from './types';

@Controller('report')
export class ReportController {
  public constructor(private readonly reportService: ReportService) {}

  @Get('history')
  @Plain(PriceHistoryType, Resource.AUTHENTICATED)
  public history(@Query() query: HistoryQueryDto): Promise<PriceHistory> {
    return this.reportService.history(query.term);
  }

  @Get(':kind')
  @Paginated(ReportRowType, Resource.AUTHENTICATED)
  public report(
    @Param() params: ReportKindParamsDto,
    @Query() query: ReportQueryDto,
  ): Promise<TypePaginated<ReportRow>> {
    return this.reportService.report(
      params.kind,
      this.toFilter(query),
      this.toOptions(query),
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
      name: query.name,
    };
  }

  private toOptions(query: ReportQueryDto): ReportOptions {
    return {
      window: query.window ?? ReportWindow.WEEK,
      minDiscount: query.minDiscount,
      sort: query.sort,
      order: query.order ?? SortOrder.ASC,
      page: query.page ?? 1,
      perPage: query.perPage ?? DEFAULT_PER_PAGE,
    };
  }
}
