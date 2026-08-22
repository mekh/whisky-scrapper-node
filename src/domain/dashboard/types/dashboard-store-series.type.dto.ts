import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

import type { DashboardStoreSeries } from '~types';

import { DashboardSeriesPointType } from './dashboard-series-point.type.dto';

export class DashboardStoreSeriesType implements DashboardStoreSeries {
  @IsString()
  public storeSlug!: string;

  @IsString()
  public name!: string;

  @IsOptional()
  @IsString()
  public color!: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DashboardSeriesPointType)
  public points!: DashboardSeriesPointType[];
}
