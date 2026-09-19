import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { FLAVOR_NAME_MAX_LENGTH } from '~constants';
import { ProducerAliasScope, ProductReviewStatus } from '~enums';
import type {
  ID,
  ReviewCommitInput,
  ReviewPatch,
  ReviewProducerLink,
} from '~types';

/**
 * Upper bound on a curated tag set. The reference table holds a few dozen
 * flavours, so this only keeps a malformed request from becoming a huge
 * insert.
 */
const MAX_FLAVORS = 64;

/**
 * Longest accepted spelling for an alias. A brand is a few words.
 */
const MAX_SPELLING = 128;

/**
 * The facts a reviewer may confirm without changing.
 */
const CONFIRMABLE = ['type', 'country', 'abv', 'volume', 'age', 'name'];

/**
 * The ways of linking a bottling to its maker.
 */
const LINK_MODES = ['pin', 'alias', 'widen-alias'];

/**
 * The facts a commit writes, each stamped `manual`.
 */
export class ReviewPatchDto implements ReviewPatch {
  @IsOptional()
  @IsString()
  public name?: string | null;

  @IsOptional()
  @IsString()
  public typeName?: string | null;

  @IsOptional()
  @IsString()
  public countryCode?: string | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(96)
  public abv?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  public volumeMl?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  public age?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_FLAVORS)
  @IsString({ each: true })
  @MaxLength(FLAVOR_NAME_MAX_LENGTH, { each: true })
  public flavors?: string[];
}

/**
 * How a commit links a bottling to its maker.
 */
export class ReviewProducerLinkDto implements ReviewProducerLink {
  @IsIn(LINK_MODES)
  public mode!: 'pin' | 'alias' | 'widen-alias';

  @IsOptional()
  @IsUUID('all')
  public producerId?: ID | null;

  @IsOptional()
  @IsUUID('all')
  public bottlerId?: ID | null;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SPELLING)
  public spelling?: string;

  @IsOptional()
  @IsUUID('all')
  public aliasId?: ID;

  @IsOptional()
  @IsEnum(ProducerAliasScope)
  public scope?: ProducerAliasScope;
}

export class ReviewCommitDto implements ReviewCommitInput {
  @IsUUID('all')
  public productId!: ID;

  @IsEnum(ProductReviewStatus)
  public verdict!: ProductReviewStatus;

  @IsOptional()
  @ValidateNested()
  @Type(() => ReviewPatchDto)
  public patch?: ReviewPatchDto;

  /**
   * Facts to stamp `manual` without changing — "this value is right", which
   * is what stops the next sync or knowledge-base pass from moving it.
   */
  @IsOptional()
  @IsArray()
  @IsIn(CONFIRMABLE, { each: true })
  public confirm?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ReviewProducerLinkDto)
  public producer?: ReviewProducerLinkDto;
}
