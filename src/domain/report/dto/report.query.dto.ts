import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

import { PER_PAGE_OPTIONS } from '~constants';
import { BoolQuery, CsvArray } from '~decorators/fields';
import { ReportSortField, ReportWindow, SortOrder } from '~enums';
import { ReportQuery } from '~types';

export class ReportQueryDto implements ReportQuery {
  @CsvArray()
  public stores?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  public minPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  public maxPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  public minVolume?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  public maxVolume?: number;

  @CsvArray()
  public flavors?: string[];

  @CsvArray()
  public excludeFlavors?: string[];

  @CsvArray()
  public types?: string[];

  @CsvArray()
  public countries?: string[];

  /**
   * Scotland regions to keep, by the market convention.
   */
  @CsvArray()
  public regions?: string[];

  /**
   * Scotland regions to drop. The exclusion is the useful half — "everything
   * except Islay" is how a peat-averse drinker shops.
   */
  @CsvArray()
  public excludeRegions?: string[];

  /**
   * Show only bottlings whose type and country both come from a trusted
   * source. Stricter than the default, which merely refuses to *match* an
   * untrusted value.
   */
  @BoolQuery()
  public verifiedFacts?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  public minDiscount?: number;

  @IsOptional()
  @IsString()
  public name?: string;

  @BoolQuery()
  public favoritesOnly?: boolean;

  @IsOptional()
  @IsEnum(ReportWindow)
  public window?: ReportWindow;

  @IsOptional()
  @IsEnum(ReportWindow)
  public discountWindow?: ReportWindow;

  @IsOptional()
  @IsEnum(ReportSortField)
  public sort?: ReportSortField;

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
  @IsIn([...PER_PAGE_OPTIONS])
  public perPage?: number;
}
