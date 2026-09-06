import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';

import type { CollectionOffer, ID } from '~types';

export class CollectionOfferType implements CollectionOffer {
  @IsString()
  public id!: ID;

  @IsString()
  public url!: string;

  @IsString()
  public storeSlug!: string;

  @IsString()
  public storeName!: string;

  @IsNumber()
  public price!: number;

  @IsOptional()
  @IsNumber()
  public oldPrice!: number | null;

  @IsOptional()
  @IsNumber()
  public referencePrice!: number | null;

  @IsOptional()
  @IsNumber()
  public discountPct!: number | null;

  @IsString()
  public currency!: string;

  @IsBoolean()
  public promo!: boolean;

  @IsString()
  public capturedDate!: string;
}
