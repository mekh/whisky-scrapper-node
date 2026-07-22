import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

import { ProductUpdateInput } from '~types';

export class ProductUpdateDto implements ProductUpdateInput {
  @IsString()
  @IsNotEmpty()
  public id!: string;

  @IsOptional()
  @IsString()
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
}
