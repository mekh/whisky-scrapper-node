import { IsNumber, IsOptional } from 'class-validator';

import type { DashboardMetric } from '~types';

export class DashboardMetricType implements DashboardMetric {
  @IsOptional()
  @IsNumber()
  public latest!: number | null;

  @IsOptional()
  @IsNumber()
  public baseline!: number | null;

  @IsOptional()
  @IsNumber()
  public delta!: number | null;

  @IsOptional()
  @IsNumber()
  public deltaPct!: number | null;
}
