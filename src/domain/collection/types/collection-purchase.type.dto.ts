import { Type } from 'class-transformer';
import {
  IsArray,
  IsDate,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

import type { CollectionPurchase, ID } from '~types';

import { CollectionPurchaseRateType } from './collection-purchase-rate.type.dto';
import { CollectionPurchaseStoreType } from './collection-purchase-store.type.dto';

export class CollectionPurchaseType implements CollectionPurchase {
  @IsString()
  public id!: ID;

  @IsString()
  public purchasedOn!: string;

  @IsOptional()
  @IsNumber()
  public price!: number | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => CollectionPurchaseStoreType)
  public store!: CollectionPurchaseStoreType | null;

  @IsOptional()
  @IsString()
  public storeName!: string | null;

  @IsOptional()
  @IsString()
  public storeProductId!: ID | null;

  @IsDate()
  public createdAt!: Date;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CollectionPurchaseRateType)
  public rates!: CollectionPurchaseRateType[];
}
