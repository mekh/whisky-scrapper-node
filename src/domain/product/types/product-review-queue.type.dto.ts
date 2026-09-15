import { Type } from 'class-transformer';
import {
  IsArray,
  IsDate,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

import type { ID, ProductReviewQueueRow } from '~types';

import { ReviewStoreLinkType } from './review-store-link.type.dto';

/**
 * One bottling in the new-product queue.
 *
 * The field set is chosen so a parse error is visible without opening
 * anything: `name` beside `nameOrig` is the comparison the screen exists for,
 * and the specs beside them are what the cleaner lifted out of that raw name.
 */
export class ProductReviewQueueType implements ProductReviewQueueRow {
  @IsString()
  public id!: ID;

  @IsOptional()
  @IsString()
  public name!: string | null;

  @IsOptional()
  @IsString()
  public nameOrig!: string | null;

  /**
   * The frozen match key — on screen nowhere else in the API. A listing keyed
   * wrongly is a duplicate that costs a manual merge later, and this is the
   * only moment it is cheap to notice.
   */
  @IsOptional()
  @IsString()
  public matchKey!: string | null;

  @IsOptional()
  @IsInt()
  public age!: number | null;

  @IsOptional()
  @IsString()
  public ageSource!: string | null;

  @IsOptional()
  @IsNumber()
  public abv!: number | null;

  @IsOptional()
  @IsString()
  public abvSource!: string | null;

  @IsOptional()
  @IsInt()
  public volumeMl!: number | null;

  @IsOptional()
  @IsString()
  public volumeSource!: string | null;

  @IsOptional()
  @IsString()
  public type!: string | null;

  @IsOptional()
  @IsString()
  public typeSource!: string | null;

  @IsOptional()
  @IsString()
  public countryCode!: string | null;

  @IsOptional()
  @IsString()
  public countryName!: string | null;

  @IsOptional()
  @IsString()
  public countryIcon!: string | null;

  @IsOptional()
  @IsString()
  public countrySource!: string | null;

  @IsOptional()
  @IsString()
  public brand!: string | null;

  @IsOptional()
  @IsString()
  public producerSlug!: string | null;

  /**
   * The spelling a shop used. A null `producerSlug` beside a non-null value
   * here is the signal "the knowledge base does not know this maker yet".
   */
  @IsOptional()
  @IsString()
  public brandOrig!: string | null;

  @IsArray()
  @IsString({ each: true })
  public flavors!: string[];

  @IsInt()
  public storeCount!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReviewStoreLinkType)
  public stores!: ReviewStoreLinkType[];

  @IsOptional()
  @IsString()
  public reviewStatus!: string | null;

  @IsOptional()
  @IsDate()
  public reviewedAt!: Date | null;

  @IsDate()
  public createdAt!: Date;
}
