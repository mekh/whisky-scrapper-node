import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

import type {
  ID,
  ReviewCandidateVia,
  ReviewDuplicateCandidate,
  ReviewDuplicateVia,
  ReviewProducerCandidate,
  ReviewSiblingValue,
  ReviewSiblings,
  ReviewSuggestions,
} from '~types';

import { ReviewProducerRefType } from './review-producer-ref.type.dto';

/**
 * How a producer candidate was found — the sentence the button states beside
 * it, and the reason the list is ordered the way it is.
 */
const CANDIDATE_VIA: ReviewCandidateVia[] = [
  'brandOrig',
  'tm-token',
  'name-word',
  'unreachable-alias',
  'similar',
];

/**
 * How a duplicate candidate was found.
 */
const DUPLICATE_VIA: ReviewDuplicateVia[] = ['identity', 'near-identity'];

/**
 * One producer the bottling might belong to.
 */
export class ReviewProducerCandidateType implements ReviewProducerCandidate {
  @ValidateNested()
  @Type(() => ReviewProducerRefType)
  public producer!: ReviewProducerRefType;

  @IsOptional()
  @IsString()
  public countryIcon!: string | null;

  @IsIn(CANDIDATE_VIA)
  public via!: ReviewCandidateVia;

  /**
   * The spelling that found it — what an alias would be minted from.
   */
  @IsString()
  public spelling!: string;

  @IsInt()
  public productCount!: number;
}

/**
 * A bottling this one may be a second copy of.
 */
export class ReviewDuplicateCandidateType implements ReviewDuplicateCandidate {
  @IsString()
  public productId!: ID;

  @IsOptional()
  @IsString()
  public name!: string | null;

  @IsOptional()
  @IsInt()
  public volumeMl!: number | null;

  @IsOptional()
  @IsInt()
  public age!: number | null;

  @IsInt()
  public storeCount!: number;

  @IsIn(DUPLICATE_VIA)
  public via!: ReviewDuplicateVia;
}

/**
 * One value identically-named bottlings state.
 */
export class ReviewSiblingValueType implements ReviewSiblingValue {
  @IsString()
  public value!: string;

  @IsString()
  public label!: string;

  @IsInt()
  public count!: number;
}

/**
 * What identically-named bottlings say about the facts this one lacks.
 */
export class ReviewSiblingsType implements ReviewSiblings {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReviewSiblingValueType)
  public abv!: ReviewSiblingValueType[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReviewSiblingValueType)
  public type!: ReviewSiblingValueType[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReviewSiblingValueType)
  public country!: ReviewSiblingValueType[];
}

/**
 * Everything the side panel loads when a bottling is opened.
 */
export class ReviewSuggestionsType implements ReviewSuggestions {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReviewProducerCandidateType)
  public producers!: ReviewProducerCandidateType[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReviewDuplicateCandidateType)
  public duplicates!: ReviewDuplicateCandidateType[];

  @ValidateNested()
  @Type(() => ReviewSiblingsType)
  public siblings!: ReviewSiblingsType;

  /**
   * Words lifted out of the shops' listing URLs, which often spell a name the
   * shop's own title truncated.
   */
  @IsArray()
  @IsString({ each: true })
  public storeHints!: string[];
}
