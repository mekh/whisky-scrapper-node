import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  PRODUCT_NAME_MAX_LENGTH,
  SEARCH_MAX_LIMIT,
  SEARCH_MIN_LENGTH,
} from '~constants';
import type { SearchQuery } from '~types';

/**
 * The server floor of `SEARCH_MIN_LENGTH` (2) only bars a catalogue scan; the
 * web client applies its own UX minimum of 3, mirroring the report search.
 */
export class ProductSearchQueryDto implements SearchQuery {
  @IsString()
  @MinLength(SEARCH_MIN_LENGTH)
  @MaxLength(PRODUCT_NAME_MAX_LENGTH)
  public q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SEARCH_MAX_LIMIT)
  public limit?: number;
}
