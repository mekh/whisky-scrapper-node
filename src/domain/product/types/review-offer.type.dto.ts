import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';

import type { ID, ReviewOffer } from '~types';

export class ReviewOfferType implements ReviewOffer {
  @IsString()
  public id!: ID;

  @IsString()
  public storeSlug!: string;

  @IsString()
  public storeName!: string;

  @IsOptional()
  @IsString()
  public storeColor!: string | null;

  @IsString()
  public sku!: string;

  @IsString()
  public nameOrig!: string;

  @IsString()
  public url!: string;

  @IsBoolean()
  public inStock!: boolean;

  @IsOptional()
  @IsNumber()
  public price!: number | null;

  @IsOptional()
  @IsString()
  public firstSeen!: string | null;

  @IsOptional()
  @IsString()
  public brandHint!: string | null;
}
