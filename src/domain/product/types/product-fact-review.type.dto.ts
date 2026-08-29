import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

import type { ID, ProductFactReviewRow } from '~types';

import { ReviewStoreLinkType } from './review-store-link.type.dto';

export class ProductFactReviewType implements ProductFactReviewRow {
  @IsString()
  public id!: ID;

  @IsOptional()
  @IsString()
  public name!: string | null;

  @IsOptional()
  @IsString()
  public nameOrig!: string | null;

  @IsOptional()
  @IsString()
  public brand!: string | null;

  @IsOptional()
  @IsString()
  public type!: string | null;

  @IsOptional()
  @IsString()
  public typeSource!: string | null;

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
  public countrySource!: string | null;

  @IsOptional()
  @IsString()
  public producerSlug!: string | null;

  @IsInt()
  public storeCount!: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReviewStoreLinkType)
  public stores!: ReviewStoreLinkType[];
}
