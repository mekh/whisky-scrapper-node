import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';

import type { DashboardStoreCoverage } from '~types';

export class DashboardStoreCoverageType implements DashboardStoreCoverage {
  @IsString()
  public slug!: string;

  @IsString()
  public name!: string;

  @IsOptional()
  @IsString()
  public color!: string | null;

  @IsBoolean()
  public active!: boolean;

  @IsOptional()
  @IsString()
  public firstDate!: string | null;

  @IsOptional()
  @IsString()
  public lastDate!: string | null;

  @IsInt()
  public listings!: number;

  @IsInt()
  public inStockListings!: number;
}
