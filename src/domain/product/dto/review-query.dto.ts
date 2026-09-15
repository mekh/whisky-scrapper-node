import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { KbStatus, ProductReviewStatus } from '~enums';

import type {
  ReviewConflictQuery,
  ReviewFactQuery,
  ReviewProducerQuery,
  ReviewQueueQuery,
} from '../product-review.interfaces';

/**
 * Largest page the review screen may ask for. The screen is a work queue, not
 * an export.
 */
const MAX_PER_PAGE = 200;

/**
 * Longest accepted search term. Anything past this is a paste error, not a
 * name.
 */
const MAX_SEARCH_LENGTH = 128;

/**
 * Which half of the facts queue to return. Validated rather than taken as a
 * free string: a typo silently meaning "both halves" is the kind of quiet
 * wrongness this screen exists to remove.
 */
const PRODUCER_SEGMENTS = ['resolved', 'unresolved'];

export class ReviewQueryDto
  implements
    ReviewProducerQuery,
    ReviewFactQuery,
    ReviewConflictQuery,
    ReviewQueueQuery {
  @IsOptional()
  @IsEnum(KbStatus)
  public status?: KbStatus;

  /**
   * Which bucket of the new-product queue to list.
   *
   * A field of its own rather than a reuse of `status` above: that one is a
   * {@link KbStatus}, whose `auto` means nothing for a bottling and which has
   * no `pending` at all. Two vocabularies, two fields.
   */
  @IsOptional()
  @IsEnum(ProductReviewStatus)
  public reviewStatus?: ProductReviewStatus;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SEARCH_LENGTH)
  public name?: string;

  @IsOptional()
  @IsString()
  public field?: string;

  @IsOptional()
  @IsIn(PRODUCER_SEGMENTS)
  public producer?: string;

  @IsOptional()
  @IsString()
  public attribute?: string;

  @IsOptional()
  @IsString()
  public store?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PER_PAGE)
  public perPage?: number;
}
