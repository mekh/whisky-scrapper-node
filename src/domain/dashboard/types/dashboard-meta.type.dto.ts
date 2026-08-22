import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

import type { DashboardMeta } from '~types';

import { DashboardStoreCoverageType } from './dashboard-store-coverage.type.dto';

export class DashboardMetaType implements DashboardMeta {
  @IsOptional()
  @IsString()
  public dataFloorDate!: string | null;

  @IsOptional()
  @IsString()
  public latestDate!: string | null;

  @IsInt()
  public dayCount!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DashboardStoreCoverageType)
  public stores!: DashboardStoreCoverageType[];
}
