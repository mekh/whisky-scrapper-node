import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { REVIEW_MAX_PER_PAGE } from '~constants';
import { ReviewIssueCode, ReviewQueueSort, ReviewQueueStatus } from '~enums';
import type { ReviewQueueQuery } from '~types';

/**
 * Longest accepted search term. Anything past this is a paste error, not a
 * name.
 */
const MAX_SEARCH_LENGTH = 128;

/**
 * Splits a comma-separated query parameter into its values.
 *
 * @param value - The raw parameter, which may already be an array when the
 *   client repeated the key.
 * @returns The values, blanks removed.
 */
const asList = ({ value }: { value: unknown }): string[] | undefined => {
  if (Array.isArray(value)) {
    return value.map(String).filter((one) => one.length > 0);
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parts = value.split(',').map((one) => one.trim())
    .filter((one) => one.length > 0);

  return parts.length ? parts : undefined;
};

/**
 * Reads an explicit `true`/`false`, since `@Type(() => Boolean)` turns the
 * string `'false'` into `true`.
 *
 * @param value - The raw parameter.
 * @returns The boolean, or undefined when the parameter was absent.
 */
const asBool = ({ value }: { value: unknown }): boolean | undefined => {
  if (value === 'true' || value === true) {
    return true;
  }

  if (value === 'false' || value === false) {
    return false;
  }

  return undefined;
};

export class ReviewQueueQueryDto implements ReviewQueueQuery {
  /**
   * The issue codes to keep, comma-separated. Validated against the closed
   * vocabulary rather than passed through: a typo silently meaning "no
   * filter" is the kind of quiet wrongness this screen exists to remove.
   */
  @IsOptional()
  @Transform(asList)
  @IsArray()
  @IsIn(Object.values(ReviewIssueCode), { each: true })
  public issue?: string[];

  /**
   * The shop slugs to keep, comma-separated, read the same way as `issue`: a
   * bottling stays when any one of them lists it.
   */
  @IsOptional()
  @Transform(asList)
  @IsArray()
  @IsString({ each: true })
  @MaxLength(MAX_SEARCH_LENGTH, { each: true })
  public store?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SEARCH_LENGTH)
  public name?: string;

  @IsOptional()
  @IsEnum(ReviewQueueStatus)
  public status?: ReviewQueueStatus;

  @IsOptional()
  @IsEnum(ReviewQueueSort)
  public sort?: ReviewQueueSort;

  @IsOptional()
  @Transform(asBool)
  @IsBoolean()
  public includeUnstocked?: boolean;

  @IsOptional()
  @Transform(asBool)
  @IsBoolean()
  public includeAcknowledged?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(REVIEW_MAX_PER_PAGE)
  public perPage?: number;
}
