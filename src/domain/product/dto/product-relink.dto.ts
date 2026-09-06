import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { FLAVOR_NAME_MAX_LENGTH, PRODUCT_NAME_MAX_LENGTH } from '~constants';
import { ProductRelinkInput } from '~types';

/**
 * Upper bound on a created bottling's tag set — the same bound the edit
 * applies, for the same reason: the reference table holds a few dozen
 * flavors, so this only keeps a malformed request from turning into a huge
 * insert.
 */
const MAX_FLAVORS = 64;

export class ProductRelinkDto implements ProductRelinkInput {
  @IsString()
  @IsNotEmpty()
  public id!: string;

  @IsOptional()
  @IsString()
  public productId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(PRODUCT_NAME_MAX_LENGTH)
  public name?: string | null;

  @IsOptional()
  @IsString()
  public countryCode?: string | null;

  @IsOptional()
  @IsString()
  public typeName?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  public age?: number | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(96)
  public abv?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  public volumeMl?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_FLAVORS)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(FLAVOR_NAME_MAX_LENGTH, { each: true })
  public flavors?: string[];
}
