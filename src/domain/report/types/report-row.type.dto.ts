import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

import type { ID, ReportRow } from '~types';

export class ReportRowType implements ReportRow {
  /**
   * Store-offer id: one row per store × SKU, and what `/report/history` and
   * `/product/:id` take.
   */
  @IsString()
  public id!: ID;

  /**
   * Canonical product id: the bottling this row is an offer of. Rows from
   * different stores sharing it are the same whisky, which is how the `best`
   * report groups them and what a manual edit applies to.
   */
  @IsString()
  public productId!: ID;

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

  @IsOptional()
  @IsInt()
  public daysDiscount!: number | null;

  @IsArray()
  @IsString({ each: true })
  public flavors!: string[];

  @IsString()
  public firstSeen!: string;

  @IsString()
  public capturedDate!: string;

  /**
   * The resolved distillery, or null when the knowledge base could not place
   * the bottling. Null is a real answer, not a gap: an undisclosed label is
   * never guessed at.
   */
  @IsOptional()
  @IsString()
  public distillery!: string | null;

  /**
   * The distillery's region by the market convention, which is what shops and
   * drinkers use — Talisker reads `islands` here and is legally Highland.
   */
  @IsOptional()
  @IsString()
  public region!: string | null;

  /**
   * The independent bottler, when there is one. A non-null value **is** the IB
   * flag; there is no separate boolean.
   */
  @IsOptional()
  @IsString()
  public bottler!: string | null;

  /**
   * Where each of the bottling's facts came from, keyed by field name.
   *
   * The client needs it to mark an unverified value rather than presenting a
   * model's guess as fact — and since `llm` and `legacy` values are excluded
   * from the type and country filters, without this the UI could not explain
   * why a whisky it displays as Scotch does not appear under Scotland.
   */
  @IsObject()
  public factSources!: Record<string, string | null>;
}
