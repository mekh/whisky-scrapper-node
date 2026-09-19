import { Type } from 'class-transformer';
import {
  IsDate,
  IsInt,
  IsObject,
  IsOptional,
  ValidateNested,
} from 'class-validator';

import type { ReviewProducerSummary, ReviewSummary } from '~types';

/**
 * The producers queue's own counters.
 */
export class ReviewProducerSummaryType implements ReviewProducerSummary {
  @IsInt()
  public open!: number;

  /**
   * How many producers each code fires on. A free-shaped record on purpose —
   * the codes are a closed vocabulary but a new one must not need a DTO
   * change before it can be counted.
   */
  @IsObject()
  public byIssue!: Record<string, number>;
}

/**
 * What the curation screen's tabs and its «Проблеми» dropdown badge
 * themselves with.
 */
export class ReviewSummaryType implements ReviewSummary {
  @IsInt()
  public open!: number;

  @IsInt()
  public verifiedToday!: number;

  @IsInt()
  public rejected!: number;

  /**
   * Of the open bottlings, how many are here for a contradiction and nothing
   * else — the number the «переглянуті розбіжності» checkbox is worth.
   */
  @IsInt()
  public conflictOnly!: number;

  @IsObject()
  public byIssue!: Record<string, number>;

  @IsOptional()
  @IsDate()
  public knowledgeBaseAppliedAt!: Date | null;

  @ValidateNested()
  @Type(() => ReviewProducerSummaryType)
  public producers!: ReviewProducerSummaryType;
}
