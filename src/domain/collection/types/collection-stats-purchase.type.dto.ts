import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

import type { CollectionStatsPurchase, ID } from '~types';

import { CollectionPurchaseStoreType } from './collection-purchase-store.type.dto';

export class CollectionStatsPurchaseType implements CollectionStatsPurchase {
  @IsString()
  public purchaseId!: ID;

  @IsString()
  public collectionId!: ID;

  @IsString()
  public productId!: ID;

  @IsOptional()
  @IsString()
  public name!: string | null;

  @IsOptional()
  @IsString()
  public nameOrig!: string | null;

  @IsOptional()
  @IsNumber()
  public age!: number | null;

  @IsOptional()
  @IsNumber()
  public abv!: number | null;

  @IsOptional()
  @IsNumber()
  public volumeMl!: number | null;

  @IsNumber()
  public price!: number;

  @IsString()
  public purchasedOn!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionPurchaseStoreType)
  public store!: CollectionPurchaseStoreType | null;

  @IsOptional()
  @IsString()
  public storeName!: string | null;
}
