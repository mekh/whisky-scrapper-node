import { IsEnum, IsOptional } from 'class-validator';

import { IsoMonth } from '~decorators/fields';
import { CollectionTimelineGranularity } from '~enums';
import type { CollectionStatsQuery } from '~types';

export class CollectionStatsQueryDto implements CollectionStatsQuery {
  @IsoMonth(true)
  public from?: string;

  @IsoMonth(true)
  public to?: string;

  @IsOptional()
  @IsEnum(CollectionTimelineGranularity)
  public granularity?: CollectionTimelineGranularity;
}
