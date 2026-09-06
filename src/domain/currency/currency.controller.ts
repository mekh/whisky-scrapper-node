import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';

import { READ_CACHE_MAX_AGE_SECONDS } from '~constants';
import { CacheControl } from '~decorators/http';
import { Plain } from '~decorators/types';
import { Action, Resource } from '~enums';
import { NotFoundError } from '~errors';
import type {
  CurrencyConversion,
  CurrencyLatestRate,
  CurrencyOption,
  CurrencyRateProbe,
  CurrencyRateSeries,
  CurrencyRateSyncReport,
} from '~types';

import {
  CurrencyConvertQueryDto,
  CurrencyRateQueryDto,
  CurrencyRateSyncDto,
  CurrencySeriesQueryDto,
} from './dto';
import {
  CurrencyConversionService,
  CurrencyRateSyncService,
  CurrencyService,
} from './services';
import {
  CurrencyConversionType,
  CurrencyLatestRateType,
  CurrencyRateSeriesType,
  CurrencyRateSyncReportType,
  CurrencyRateType,
  CurrencyType,
} from './types';

/**
 * `POST /currency/rate/sync` reuses `store:sync` rather than adding a
 * `Resource` of its own, following `POST /push/digest`: the permission to
 * start a sync is already the permission to cause one, and a new enum member
 * would surface a row in the permissions editor for no gain.
 */
@Controller('currency')
export class CurrencyController {
  public constructor(
    private readonly currencies: CurrencyService,
    private readonly conversion: CurrencyConversionService,
    private readonly sync: CurrencyRateSyncService,
  ) {}

  @Get()
  @CacheControl(READ_CACHE_MAX_AGE_SECONDS)
  @Plain([CurrencyType], Resource.AUTHENTICATED)
  public options(): Promise<CurrencyOption[]> {
    return this.currencies.options();
  }

  @Get('rate/latest')
  @CacheControl(READ_CACHE_MAX_AGE_SECONDS)
  @Plain([CurrencyLatestRateType], Resource.AUTHENTICATED)
  public latest(): Promise<CurrencyLatestRate[]> {
    return this.currencies.latest();
  }

  @Get('rate/series')
  @CacheControl(READ_CACHE_MAX_AGE_SECONDS)
  @Plain(CurrencyRateSeriesType, Resource.AUTHENTICATED)
  public series(
    @Query() query: CurrencySeriesQueryDto,
  ): Promise<CurrencyRateSeries> {
    return this.currencies.series(query.code, query.from, query.to);
  }

  @Get('rate')
  @CacheControl(READ_CACHE_MAX_AGE_SECONDS)
  @Plain([CurrencyRateType], Resource.AUTHENTICATED)
  public rates(
    @Query() query: CurrencyRateQueryDto,
  ): Promise<CurrencyRateProbe[]> {
    return this.currencies.ratesOn(query.codes ?? [], query.date);
  }

  @Get('convert')
  @CacheControl(READ_CACHE_MAX_AGE_SECONDS)
  @Plain(CurrencyConversionType, Resource.AUTHENTICATED)
  public async convert(
    @Query() query: CurrencyConvertQueryDto,
  ): Promise<CurrencyConversion> {
    const converted = await this.conversion.convert({
      amount: query.amount,
      from: query.from,
      to: query.to,
      on: query.date,
    });

    if (!converted) {
      throw new NotFoundError(
        `No NBU rate for ${query.from}/${query.to} on or before `
          + `${query.date ?? 'today'}`,
      );
    }

    return converted;
  }

  @Post('rate/sync')
  @HttpCode(HttpStatus.OK)
  @Plain(CurrencyRateSyncReportType, [Resource.STORE, Action.SYNC])
  public runSync(
    @Body() body: CurrencyRateSyncDto,
  ): Promise<CurrencyRateSyncReport> {
    return this.sync.sync(body);
  }
}
