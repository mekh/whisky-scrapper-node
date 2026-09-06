import {
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
import type { CollectionPurchaseInput, ID } from '~types';

export class CollectionPurchaseDto implements CollectionPurchaseInput {
  @IsoDate(true)
  public purchasedOn?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: PRICE_SCALE })
  @Min(0)
  public price?: number;

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
  @GuidV7()
  public storeProductId?: ID;
}
