import { IsInt, IsNumber, IsOptional, IsString } from 'class-validator';

import type { DashboardSeriesPoint } from '~types';

export class DashboardSeriesPointType implements DashboardSeriesPoint {
  @IsString()
  public date!: string;

  @IsInt()
  public inStockListings!: number;

  @IsInt()
  public trackedListings!: number;

  @IsInt()
  public oosListings!: number;

  @IsInt()
  public distinctProducts!: number;

  @IsInt()
  public distinctBrands!: number;

  @IsInt()
  public activeStores!: number;

  @IsOptional()
  @IsNumber()
  public medianPrice!: number | null;

  @IsOptional()
  @IsNumber()
  public p25Price!: number | null;

  @IsOptional()
  @IsNumber()
  public p75Price!: number | null;

  @IsInt()
  public promoListings!: number;

  @IsInt()
  public newListings!: number;

  @IsInt()
  public departedListings!: number;
}
