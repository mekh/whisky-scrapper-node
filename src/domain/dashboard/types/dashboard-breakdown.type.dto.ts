import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsString,
  ValidateNested,
} from 'class-validator';

import { DashboardBreakdownBy } from '~enums';
import type { DashboardBreakdown } from '~types';

import { DashboardBreakdownBucketType } from './dashboard-breakdown-bucket.type.dto';

export class DashboardBreakdownType implements DashboardBreakdown {
  @IsEnum(DashboardBreakdownBy)
  public by!: DashboardBreakdownBy;

  @IsString()
  public date!: string;

  @IsBoolean()
  public overlapping!: boolean;

  @IsInt()
  public totalListings!: number;

  @IsInt()
  public totalProducts!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DashboardBreakdownBucketType)
  public buckets!: DashboardBreakdownBucketType[];
}
