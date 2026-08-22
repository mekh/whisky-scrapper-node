import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

import type { ID, ProductSearchItem } from '~types';

export class ProductSearchItemType implements ProductSearchItem {
  @IsString()
  public productId!: ID;

  @IsOptional()
  @IsString()
  public name!: string | null;

  @IsOptional()
  @IsString()
  public nameOrig!: string | null;

  @IsOptional()
  @IsString()
  public brand!: string | null;

  @IsOptional()
  @IsInt()
  public age!: number | null;

  @IsOptional()
  @IsNumber()
  public abv!: number | null;

  @IsOptional()
  @IsInt()
  public volumeMl!: number | null;

  @IsBoolean()
  public inStock!: boolean;
}
