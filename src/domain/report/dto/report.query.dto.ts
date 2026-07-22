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
import { CsvArray } from '~decorators/fields';
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

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  public minDiscount?: number;

  @IsOptional()
  @IsString()
  public name?: string;

  @IsOptional()
  @IsEnum(ReportWindow)
  public window?: ReportWindow;

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
