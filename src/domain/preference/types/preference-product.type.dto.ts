import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

import type { ID, PreferenceProduct } from '~types';

/**
 * Mirrors `ProductSearchItemType` (domain/product) plus `addedOn`. The seven
 * shared fields are duplicated on purpose: sharing the class would couple two
 * domain features for seven lines, and the shape they agree on already lives
 * in `~types` (`PreferenceProduct extends ProductSearchItem`).
 */
export class PreferenceProductType implements PreferenceProduct {
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

  @IsString()
  public addedOn!: string;
}
