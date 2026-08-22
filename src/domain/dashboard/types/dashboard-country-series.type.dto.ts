import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

import type { DashboardCountrySeries } from '~types';

import { DashboardSeriesPointType } from './dashboard-series-point.type.dto';

export class DashboardCountrySeriesType implements DashboardCountrySeries {
  @IsString()
  public countryCode!: string;

  @IsString()
  public nameUa!: string;

  @IsOptional()
  @IsString()
  public icon!: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DashboardSeriesPointType)
  public points!: DashboardSeriesPointType[];
}
