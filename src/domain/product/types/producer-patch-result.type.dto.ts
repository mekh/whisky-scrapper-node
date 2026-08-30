import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';

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
}
