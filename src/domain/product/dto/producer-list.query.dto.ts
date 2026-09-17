import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { PRODUCER_MAX_PAGE_SIZE } from '~constants';
import { KbStatus, ProducerKind, ProducerSortField, SortOrder } from '~enums';
import type { ProducerListQuery } from '~types';

/**
 * Longest accepted search term. Anything past this is a paste error.
 */
const MAX_SEARCH_LENGTH = 128;

export class ProducerListQueryDto implements ProducerListQuery {
  @IsOptional()
  @IsEnum(ProducerKind)
  public kind?: ProducerKind;

  @IsOptional()
  @IsEnum(KbStatus)
  public status?: KbStatus;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SEARCH_LENGTH)
  public name?: string;

  /**
   * Absent is the third sort state — the listing's own order, which no column
   * header can express.
   */
  @IsOptional()
  @IsEnum(ProducerSortField)
  public sort?: ProducerSortField;

  @IsOptional()
  @IsEnum(SortOrder)
  public order?: SortOrder;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  public page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PRODUCER_MAX_PAGE_SIZE)
  public perPage?: number;
}
