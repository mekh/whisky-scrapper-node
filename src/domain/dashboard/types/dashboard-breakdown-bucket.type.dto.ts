import { IsInt, IsNumber, IsOptional, IsString } from 'class-validator';

import type { DashboardBreakdownBucket } from '~types';

export class DashboardBreakdownBucketType implements DashboardBreakdownBucket {
  @IsString()
  public key!: string;

  @IsInt()
  public listings!: number;

  @IsInt()
  public products!: number;

  @IsOptional()
  @IsNumber()
  public medianPrice!: number | null;

  @IsOptional()
  @IsNumber()
  public minPrice!: number | null;

  @IsOptional()
  @IsNumber()
  public maxPrice!: number | null;
}
