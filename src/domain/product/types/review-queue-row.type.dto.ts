import { Type } from 'class-transformer';
import {
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

import { ProductReviewStatus } from '~enums';
import type { ID, ReviewQueueRow } from '~types';

import { ReviewConflictType } from './review-conflict.type.dto';
import { ReviewIssueType } from './review-issue.type.dto';
import { ReviewOfferType } from './review-offer.type.dto';
import { ReviewProducerRefType } from './review-producer-ref.type.dto';

/**
 * One bottling in the curation queue.
 *
 * The field set is what a decision is made from without opening a second
 * screen: `name` beside `nameOrig` is the comparison a parse error shows up
 * in, every fact carries the source that decides whether a filter trusts it,
 * and `issues` says why the row is here at all.
 */
export class ReviewQueueRowType implements ReviewQueueRow {
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
  @ValidateNested()
  @Type(() => ReviewProducerRefType)
  public producer!: ReviewProducerRefType | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => ReviewProducerRefType)
  public bottler!: ReviewProducerRefType | null;

  @IsOptional()
  @IsString()
  public producerSource!: string | null;

  /**
   * The spelling a shop used. A null producer beside a non-null value here is
   * the signal "the knowledge base does not know this maker yet".
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
  @Type(() => ReviewOfferType)
  public offers!: ReviewOfferType[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReviewConflictType)
  public conflicts!: ReviewConflictType[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReviewIssueType)
  public issues!: ReviewIssueType[];

  @IsOptional()
  @IsEnum(ProductReviewStatus)
  public reviewStatus!: ProductReviewStatus | null;

  @IsOptional()
  @IsDate()
  public reviewedAt!: Date | null;

  @IsDate()
  public createdAt!: Date;
}
