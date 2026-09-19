import { Transform, Type } from 'class-transformer';
import {
  IsArray,
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
import { KbStatus, ProducerIssueCode, ProducerKind } from '~enums';
import type { ProducerQueueQuery } from '~types';

/**
 * Longest accepted search term.
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

export class ProducerQueueQueryDto implements ProducerQueueQuery {
  @IsOptional()
  @Transform(asList)
  @IsArray()
  @IsIn(Object.values(ProducerIssueCode), { each: true })
  public issue?: string[];

  @IsOptional()
  @IsEnum(KbStatus)
  public status?: KbStatus;

  @IsOptional()
  @IsEnum(ProducerKind)
  public kind?: ProducerKind;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SEARCH_LENGTH)
  public name?: string;

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
