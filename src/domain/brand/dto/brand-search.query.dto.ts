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
  BRAND_NAME_MAX_LENGTH,
  SEARCH_MAX_LIMIT,
  SEARCH_MIN_LENGTH,
} from '~constants';
import type { SearchQuery } from '~types';

export class BrandSearchQueryDto implements SearchQuery {
  @IsString()
  @MinLength(SEARCH_MIN_LENGTH)
  @MaxLength(BRAND_NAME_MAX_LENGTH)
  public q!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SEARCH_MAX_LIMIT)
  public limit?: number;
}
