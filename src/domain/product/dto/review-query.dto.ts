import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

import { KbStatus } from '~enums';

/**
 * Largest page the review screen may ask for. The screen is a work queue, not
 * an export.
 */
const MAX_PER_PAGE = 200;

/**
 * Which half of the facts queue to return. Validated rather than taken as a
 * free string: a typo silently meaning "both halves" is the kind of quiet
 * wrongness this screen exists to remove.
 */
const PRODUCER_SEGMENTS = ['resolved', 'unresolved'];

export class ReviewQueryDto {
  @IsOptional()
  @IsEnum(KbStatus)
  public status?: KbStatus;

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
