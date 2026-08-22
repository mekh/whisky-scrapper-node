import { Type } from 'class-transformer';
import { IsArray, IsString, ValidateNested } from 'class-validator';

import type { DashboardSyncActivity } from '~types';

import { DashboardSyncDayType } from './dashboard-sync-day.type.dto';

export class DashboardSyncActivityType implements DashboardSyncActivity {
  @IsString()
  public from!: string;

  @IsString()
  public to!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DashboardSyncDayType)
  public days!: DashboardSyncDayType[];
}
