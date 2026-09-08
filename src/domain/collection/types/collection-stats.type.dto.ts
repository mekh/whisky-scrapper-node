import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

import type { CollectionStats } from '~types';

import { CollectionCountryBucketType } from './collection-country-bucket.type.dto';
import { CollectionRegionBucketType } from './collection-region-bucket.type.dto';
import { CollectionStatsBoundsType } from './collection-stats-bounds.type.dto';
import { CollectionStatsPurchaseType } from './collection-stats-purchase.type.dto';
import { CollectionStoreBucketType } from './collection-store-bucket.type.dto';
import { CollectionTimelineType } from './collection-timeline.type.dto';

export class CollectionStatsType implements CollectionStats {
  @IsString()
  public currency!: string;

  @IsInt()
  public items!: number;

  @IsInt()
  public bottles!: number;

  @IsInt()
  public pricedBottles!: number;

  @IsNumber()
  public totalSpent!: number;

  @IsOptional()
  @IsNumber()
  public avgPrice!: number | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionStatsPurchaseType)
  public mostExpensive!: CollectionStatsPurchaseType | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionStatsPurchaseType)
  public cheapest!: CollectionStatsPurchaseType | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CollectionCountryBucketType)
  public byCountry!: CollectionCountryBucketType[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CollectionRegionBucketType)
  public byRegion!: CollectionRegionBucketType[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CollectionStoreBucketType)
  public byStore!: CollectionStoreBucketType[];

  @ValidateNested()
  @Type(() => CollectionTimelineType)
  public timeline!: CollectionTimelineType;

  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionStatsBoundsType)
  public bounds!: CollectionStatsBoundsType | null;
}
