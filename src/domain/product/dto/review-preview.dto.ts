import { Type } from 'class-transformer';
import { IsUUID, ValidateNested } from 'class-validator';

import type { ID } from '~types';

import { ReviewProducerLinkDto } from './review-commit.dto';

/**
 * What an action would do, asked before it is taken.
 *
 * Only the producer link is asked about, because only it reaches beyond the
 * bottling being edited: a fact patch writes one row and stamps it `manual`,
 * which by construction touches nothing else.
 */
export class ReviewPreviewDto {
  @IsUUID('all')
  public productId!: ID;

  @ValidateNested()
  @Type(() => ReviewProducerLinkDto)
  public producer!: ReviewProducerLinkDto;
}
