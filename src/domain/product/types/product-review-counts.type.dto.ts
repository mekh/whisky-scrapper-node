import { IsInt } from 'class-validator';

import type { ProductReviewStatusCounts } from '~types';

/**
 * The catalogue counted by its place in the curation queue.
 *
 * The four statuses sum to the whole `product` table, which is also the
 * invariant that says null is the only fourth state.
 */
export class ProductReviewCountsType implements ProductReviewStatusCounts {
  @IsInt()
  public pending!: number;

  @IsInt()
  public verified!: number;

  @IsInt()
  public rejected!: number;

  /**
   * Predates the queue and was deliberately not enrolled in it — the number a
   * retro-enqueue decision would be made on.
   */
  @IsInt()
  public legacy!: number;

  /**
   * How many were verified since midnight.
   */
  @IsInt()
  public verifiedToday!: number;
}
