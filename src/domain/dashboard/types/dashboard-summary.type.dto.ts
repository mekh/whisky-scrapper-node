import { Type } from 'class-transformer';
import { IsOptional, IsString, ValidateNested } from 'class-validator';

import type { DashboardSummary } from '~types';

import { DashboardMetricType } from './dashboard-metric.type.dto';

export class DashboardSummaryType implements DashboardSummary {
  @IsString()
  public from!: string;

  @IsString()
  public to!: string;

  @IsOptional()
  @IsString()
  public baselineDate!: string | null;

  @IsOptional()
  @IsString()
  public latestDate!: string | null;

  @ValidateNested()
  @Type(() => DashboardMetricType)
  public inStockListings!: DashboardMetricType;

  @ValidateNested()
  @Type(() => DashboardMetricType)
  public trackedListings!: DashboardMetricType;

  @ValidateNested()
  @Type(() => DashboardMetricType)
  public oosListings!: DashboardMetricType;

  @ValidateNested()
  @Type(() => DashboardMetricType)
  public distinctProducts!: DashboardMetricType;

  @ValidateNested()
  @Type(() => DashboardMetricType)
  public distinctBrands!: DashboardMetricType;

  @ValidateNested()
  @Type(() => DashboardMetricType)
  public medianPrice!: DashboardMetricType;

  @ValidateNested()
  @Type(() => DashboardMetricType)
  public promoShare!: DashboardMetricType;

  @ValidateNested()
  @Type(() => DashboardMetricType)
  public activeStores!: DashboardMetricType;
}
