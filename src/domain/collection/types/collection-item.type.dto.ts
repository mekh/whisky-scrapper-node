import { Type } from 'class-transformer';
import {
  IsArray,
  IsDate,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

import type { CollectionItem, ID } from '~types';

import { CollectionOfferType } from './collection-offer.type.dto';
import { CollectionPurchaseType } from './collection-purchase.type.dto';

export class CollectionItemType implements CollectionItem {
  @IsString()
  public id!: ID;

  @IsString()
  public productId!: ID;

  @IsOptional()
  @IsNumber()
  public rating!: number | null;

  @IsOptional()
  @IsString()
  public barcode!: string | null;

  @IsOptional()
  @IsString()
  public notes!: string | null;

  @IsOptional()
  @IsString()
  public nose!: string | null;

  @IsOptional()
  @IsString()
  public palate!: string | null;

  @IsOptional()
  @IsString()
  public finish!: string | null;

  @IsDate()
  public createdAt!: Date;

  @IsDate()
  public updatedAt!: Date;

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

  @IsOptional()
  @IsString()
  public brand!: string | null;

  @IsOptional()
  @IsString()
  public distillery!: string | null;

  @IsOptional()
  @IsString()
  public bottler!: string | null;

  @IsOptional()
  @IsString()
  public type!: string | null;

  @IsOptional()
  @IsString()
  public countryCode!: string | null;

  @IsOptional()
  @IsString()
  public countryName!: string | null;

  @IsOptional()
  @IsString()
  public countryIcon!: string | null;

  @IsOptional()
  @IsString()
  public region!: string | null;

  @IsArray()
  @IsString({ each: true })
  public flavors!: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CollectionPurchaseType)
  public purchases!: CollectionPurchaseType[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CollectionOfferType)
  public offers!: CollectionOfferType[];
}
