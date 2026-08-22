import { IsInt, IsOptional, IsString } from 'class-validator';

import type { DashboardSyncDay } from '~types';

export class DashboardSyncDayType implements DashboardSyncDay {
  @IsString()
  public date!: string;

  @IsInt()
  public runs!: number;

  @IsInt()
  public succeeded!: number;

  @IsInt()
  public failed!: number;

  @IsInt()
  public running!: number;

  @IsInt()
  public added!: number;

  @IsInt()
  public removed!: number;

  @IsInt()
  public updated!: number;

  @IsInt()
  public itemsSeen!: number;

  @IsOptional()
  @IsInt()
  public avgDurationMs!: number | null;

  @IsOptional()
  @IsInt()
  public maxDurationMs!: number | null;
}
