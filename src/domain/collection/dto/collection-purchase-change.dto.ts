import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

import {
  PRICE_SCALE,
  STORE_NAME_MAX_LENGTH,
  STORE_SLUG_MAX_LENGTH,
} from '~constants';
import { GuidV7, IsoDate } from '~decorators/fields';
import type { CollectionPurchaseChangeInput, ID } from '~types';

/**
 * One entry of `CollectionPurchasesPatchDto.update`: the purchase to patch
 * and the fields to change on it. The `clear*` flags are the only way to
 * remove a value, since an absent key means "leave it alone".
 */
export class CollectionPurchaseChangeDto
  implements CollectionPurchaseChangeInput {
  @GuidV7()
  public id!: ID;

  @IsoDate(true)
  public purchasedOn?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: PRICE_SCALE })
  @Min(0)
  public price?: number;

  @IsOptional()
  @IsBoolean()
  public clearPrice?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(STORE_SLUG_MAX_LENGTH)
  public storeSlug?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(STORE_NAME_MAX_LENGTH)
  public storeName?: string;

  @IsOptional()
  @IsBoolean()
  public clearStore?: boolean;
}
