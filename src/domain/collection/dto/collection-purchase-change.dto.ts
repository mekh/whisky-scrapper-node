import { IsBoolean, IsNumber, IsOptional, Max, Min } from 'class-validator';

import {
  COLLECTION_PRICE_MAX,
  PRICE_SCALE,
  STORE_NAME_MAX_LENGTH,
  STORE_SLUG_MAX_LENGTH,
} from '~constants';
import { GuidV7, IsoDate, SafeText } from '~decorators/fields';
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
  @Max(COLLECTION_PRICE_MAX)
  public price?: number;

  @IsOptional()
  @IsBoolean()
  public clearPrice?: boolean;

  @SafeText({ max: STORE_SLUG_MAX_LENGTH, optional: true })
  public storeSlug?: string;

  @SafeText({
    max: STORE_NAME_MAX_LENGTH,
    optional: true,
    notEmpty: true,
  })
  public storeName?: string;

  @IsOptional()
  @IsBoolean()
  public clearStore?: boolean;
}
