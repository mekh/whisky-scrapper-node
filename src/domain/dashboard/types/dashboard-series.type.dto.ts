import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsString, ValidateNested } from 'class-validator';

import { DashboardGranularity } from '~enums';
import type { DashboardSeries } from '~types';

import { DashboardCountrySeriesType } from './dashboard-country-series.type.dto';
import { DashboardSeriesPointType } from './dashboard-series-point.type.dto';
import { DashboardStoreSeriesType } from './dashboard-store-series.type.dto';

export class DashboardSeriesType implements DashboardSeries {
  @IsString()
  public from!: string;

  @IsString()
  public to!: string;

  @IsEnum(DashboardGranularity)
  public granularity!: DashboardGranularity;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DashboardSeriesPointType)
  public total!: DashboardSeriesPointType[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DashboardStoreSeriesType)
  public byStore!: DashboardStoreSeriesType[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DashboardCountrySeriesType)
  public byCountry!: DashboardCountrySeriesType[];
}
