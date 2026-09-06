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
import { IsoDate } from '~decorators/fields';
import type { CollectionPurchaseUpdateInput } from '~types';

export class CollectionPurchaseUpdateDto
  implements CollectionPurchaseUpdateInput {
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
