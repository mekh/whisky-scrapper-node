import { IsEnum, IsOptional } from 'class-validator';

import { BoolQuery } from '~decorators/fields';
import { DashboardGranularity } from '~enums';
import { DashboardSeriesQuery } from '~types';

import { DashboardRangeQueryDto } from './dashboard-range.query.dto';

export class DashboardSeriesQueryDto extends DashboardRangeQueryDto
  implements DashboardSeriesQuery {
  @BoolQuery()
  public byStore?: boolean;

  @BoolQuery()
  public byCountry?: boolean;

  @IsOptional()
  @IsEnum(DashboardGranularity)
  public granularity?: DashboardGranularity;
}
