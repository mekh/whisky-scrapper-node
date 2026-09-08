import { IsEnum, IsOptional } from 'class-validator';

import { CurrencyCode, IsoMonth } from '~decorators/fields';
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

  @CurrencyCode(true)
  public currency?: string;
}
