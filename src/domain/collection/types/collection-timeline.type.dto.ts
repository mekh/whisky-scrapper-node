import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsString, ValidateNested } from 'class-validator';

import { CollectionTimelineGranularity } from '~enums';
import type { CollectionTimeline } from '~types';

import { CollectionTimelineBucketType } from './collection-timeline-bucket.type.dto';

export class CollectionTimelineType implements CollectionTimeline {
  @IsEnum(CollectionTimelineGranularity)
  public granularity!: CollectionTimelineGranularity;

  @IsString()
  public from!: string;

  @IsString()
  public to!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CollectionTimelineBucketType)
  public buckets!: CollectionTimelineBucketType[];
}
