import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

import { DASHBOARD_MOVERS_MAX_LIMIT } from '~constants';
import { DashboardMoversQuery } from '~types';

import { DashboardRangeQueryDto } from './dashboard-range.query.dto';

export class DashboardMoversQueryDto extends DashboardRangeQueryDto
  implements DashboardMoversQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DASHBOARD_MOVERS_MAX_LIMIT)
  public limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  public minPrice?: number;
}
