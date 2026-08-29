import { IsDate, IsInt, IsOptional, IsString } from 'class-validator';

import type {
  KbStatus,
  PeatProfile,
  ProducerKind,
  ScotlandLegalRegion,
  ScotlandRegion,
} from '~enums';
import type { ID, ProducerReviewRow } from '~types';

export class ProducerReviewType implements ProducerReviewRow {
  @IsString()
  public id!: ID;

  @IsString()
  public slug!: string;

  @IsString()
  public name!: string;

  @IsString()
  public kind!: ProducerKind;

  @IsOptional()
  @IsString()
  public region!: ScotlandRegion | null;

  @IsOptional()
  @IsString()
  public legalRegion!: ScotlandLegalRegion | null;

  @IsOptional()
  @IsString()
  public owner!: string | null;

  @IsOptional()
  @IsString()
  public defaultTypeName!: string | null;

  @IsString()
  public peatProfile!: PeatProfile;

  @IsString()
  public status!: KbStatus;

  @IsOptional()
  @IsString()
  public confidence!: string | null;

  @IsOptional()
  @IsString()
  public sourceUrls!: string | null;

  @IsOptional()
  @IsString()
  public note!: string | null;

  @IsOptional()
  @IsDate()
  public verifiedAt!: Date | null;

  @IsOptional()
  @IsString()
  public countryCode!: string | null;

  @IsOptional()
  @IsString()
  public parentSlug!: string | null;

  @IsOptional()
  @IsString()
  public bottlerSlug!: string | null;

  @IsInt()
  public productCount!: number;

  @IsOptional()
  @IsInt()
  public potentialReach!: number | null;
}
