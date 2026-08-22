import { Type } from 'class-transformer';
import { IsArray, IsString, ValidateNested } from 'class-validator';

import type { DashboardMovers } from '~types';

import { DashboardMoverType } from './dashboard-mover.type.dto';

export class DashboardMoversType implements DashboardMovers {
  @IsString()
  public from!: string;

  @IsString()
  public to!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DashboardMoverType)
  public drops!: DashboardMoverType[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DashboardMoverType)
  public rises!: DashboardMoverType[];
}
