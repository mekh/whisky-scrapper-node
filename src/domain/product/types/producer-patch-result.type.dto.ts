import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';

import type { ProducerPatchResult } from '~types';

import { KbReconcileSummaryType } from './kb-reconcile-summary.type.dto';
import { ProducerReviewType } from './producer-review.type.dto';

export class ProducerPatchResultType implements ProducerPatchResult {
  @ValidateNested()
  @Type(() => ProducerReviewType)
  public producer!: ProducerReviewType;

  @ValidateNested()
  @Type(() => KbReconcileSummaryType)
  public applied!: KbReconcileSummaryType;

  /**
   * Spellings another producer already claims, skipped rather than dropped in
   * silence — a spelling that quietly did not take is a producer that quietly
   * does not resolve.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  public skippedAliases?: string[];
}
