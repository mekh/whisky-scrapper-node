import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

import {
  PRODUCER_ALIASES_MAX_PER_REQUEST,
  PRODUCER_ALIAS_MAX_LENGTH,
  PRODUCER_NAME_MAX_LENGTH,
  PRODUCER_OWNER_MAX_LENGTH,
  PRODUCER_SLUG_MAX_LENGTH,
  WHISKY_TYPE_NAME_MAX_LENGTH,
} from '~constants';
import { SafeText } from '~decorators/fields';
import {
  KbStatus,
  PeatProfile,
  ProducerKind,
  ScotlandLegalRegion,
  ScotlandRegion,
} from '~enums';
import type { ID, ProducerCreateInput } from '~types';

/**
 * Upper bound on the citation and note fields, matching `ProducerPatchDto`.
 */
const TEXT_MAX = 512;

/**
 * Width of an ISO country code as `country.code` holds it (`GB-SCT`).
 */
const COUNTRY_CODE_MAX = 16;

export class ProducerCreateDto implements ProducerCreateInput {
  @SafeText({ max: PRODUCER_NAME_MAX_LENGTH, notEmpty: true })
  public name!: string;

  @IsEnum(ProducerKind)
  public kind!: ProducerKind;

  @IsOptional()
  @IsString()
  @MaxLength(PRODUCER_SLUG_MAX_LENGTH)
  public slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(COUNTRY_CODE_MAX)
  public countryCode?: string;

  @IsOptional()
  @IsEnum(ScotlandRegion)
  public region?: ScotlandRegion;

  @IsOptional()
  @IsEnum(ScotlandLegalRegion)
  public legalRegion?: ScotlandLegalRegion;

  @SafeText({ max: PRODUCER_OWNER_MAX_LENGTH, optional: true })
  public owner?: string;

  @IsOptional()
  @IsUUID()
  public parentId?: ID;

  @IsOptional()
  @IsUUID()
  public bottlerId?: ID;

  @IsOptional()
  @IsString()
  @MaxLength(WHISKY_TYPE_NAME_MAX_LENGTH)
  public defaultTypeName?: string;

  @IsOptional()
  @IsEnum(PeatProfile)
  public peatProfile?: PeatProfile;

  @IsOptional()
  @IsEnum(KbStatus)
  public status?: KbStatus;

  @SafeText({ max: TEXT_MAX, optional: true })
  public sourceUrls?: string;

  @SafeText({ max: TEXT_MAX, multiline: true, optional: true })
  public note?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PRODUCER_ALIASES_MAX_PER_REQUEST)
  @IsString({ each: true })
  @MaxLength(PRODUCER_ALIAS_MAX_LENGTH, { each: true })
  public aliases?: string[];
}
