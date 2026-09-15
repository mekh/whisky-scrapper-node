import { IsInt } from 'class-validator';

import type { ProductReviewStatusCounts } from '~types';

/**
 * How the catalogue is distributed across the new-product queue.
 *
 * A class rather than the flat inline object `producers` uses on the summary,
 * because this shape is served in two places — inside the summary and as the
 * answer to the review mutation — and the whole point of the second is that a
 * client can redraw its badges without a follow-up read.
 */
export class ProductReviewCountsType implements ProductReviewStatusCounts {
  @IsInt()
  public pending!: number;

  @IsInt()
  public verified!: number;

  @IsInt()
  public rejected!: number;

  /**
   * Bottlings that predate the queue and were deliberately not enrolled. Not
   * work — it is the share of the catalogue nobody has ever looked at, and the
   * number a retro-enqueue decision is made on.
   */
  @IsInt()
  public legacy!: number;
}
