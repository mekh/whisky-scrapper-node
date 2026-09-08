import { IsNumber, IsOptional, Max, Min } from 'class-validator';

import {
  COLLECTION_PRICE_MAX,
  PRICE_SCALE,
  STORE_NAME_MAX_LENGTH,
  STORE_SLUG_MAX_LENGTH,
} from '~constants';
import { GuidV7, IsoDate, SafeText } from '~decorators/fields';
import type { CollectionPurchaseInput, ID } from '~types';

export class CollectionPurchaseDto implements CollectionPurchaseInput {
  @IsoDate(true)
  public purchasedOn?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: PRICE_SCALE })
  @Min(0)
  @Max(COLLECTION_PRICE_MAX)
  public price?: number;

  @SafeText({ max: STORE_SLUG_MAX_LENGTH, optional: true })
  public storeSlug?: string;

  @SafeText({
    max: STORE_NAME_MAX_LENGTH,
    optional: true,
    notEmpty: true,
  })
  public storeName?: string;

  @IsOptional()
  @GuidV7()
  public storeProductId?: ID;
}
