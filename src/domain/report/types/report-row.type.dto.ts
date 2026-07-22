import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

import type { ID, ReportRow } from '~types';

export class ReportRowType implements ReportRow {
  @IsString()
  public id!: ID;

  @IsString()
  public sku!: string;

  @IsString()
  public url!: string;

  @IsOptional()
  @IsString()
  public name!: string | null;

  @IsString()
  public nameOrig!: string;

  @IsOptional()
  @IsInt()
  public age!: number | null;

  @IsOptional()
  @IsNumber()
  public abv!: number | null;

  @IsOptional()
  @IsInt()
  public volumeMl!: number | null;

  @IsString()
  public storeSlug!: string;

  @IsString()
  public storeName!: string;

  @IsOptional()
  @IsString()
  public brand!: string | null;

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

  @IsNumber()
  public price!: number;

  @IsOptional()
  @IsNumber()
  public oldPrice!: number | null;

  @IsString()
  public currency!: string;

  @IsBoolean()
  public inStock!: boolean;

  @IsBoolean()
  public promo!: boolean;

  @IsOptional()
  @IsNumber()
  public previousPrice!: number | null;

  @IsOptional()
  @IsNumber()
  public referencePrice!: number | null;

  @IsOptional()
  @IsInt()
  public discountPct!: number | null;

  @IsBoolean()
  public isNew!: boolean;

  @IsOptional()
  @IsInt()
  public daysNew!: number | null;

  @IsArray()
  @IsString({ each: true })
  public flavors!: string[];

  @IsString()
  public firstSeen!: string;

  @IsString()
  public capturedDate!: string;
}
