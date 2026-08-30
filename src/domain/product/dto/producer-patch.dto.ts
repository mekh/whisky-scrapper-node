import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import {
  KbStatus,
  PeatProfile,
  ProducerKind,
  ScotlandLegalRegion,
  ScotlandRegion,
} from '~enums';

import type { ProducerPatchInput } from '../product-review.interfaces';

/**
 * Upper bound on the free-text fields, matching the entity's own columns.
 */
const TEXT_MAX = 512;

export class ProducerPatchDto implements ProducerPatchInput {
  @IsOptional()
  @IsString()
  @MaxLength(TEXT_MAX)
  public name?: string;

  @IsOptional()
  @IsEnum(ProducerKind)
  public kind?: ProducerKind;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT_MAX)
  public countryCode?: string;

  @IsOptional()
  @IsEnum(ScotlandRegion)
  public region?: ScotlandRegion;

  @IsOptional()
  @IsBoolean()
  public clearRegion?: boolean;

  @IsOptional()
  @IsEnum(ScotlandLegalRegion)
  public legalRegion?: ScotlandLegalRegion;

  @IsOptional()
  @IsBoolean()
  public clearLegalRegion?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT_MAX)
  public owner?: string;

  @IsOptional()
  @IsBoolean()
  public clearOwner?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT_MAX)
  public defaultTypeName?: string;

  @IsOptional()
  @IsBoolean()
  public clearDefaultTypeName?: boolean;

  @IsOptional()
  @IsEnum(PeatProfile)
  public peatProfile?: PeatProfile;

  @IsOptional()
  @IsEnum(KbStatus)
  public status?: KbStatus;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT_MAX)
  public sourceUrls?: string;

  @IsOptional()
  @IsString()
  @MaxLength(TEXT_MAX)
  public note?: string;
}
