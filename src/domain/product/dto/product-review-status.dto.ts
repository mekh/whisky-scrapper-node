import { ArrayMaxSize, ArrayNotEmpty, IsEnum, IsUUID } from 'class-validator';

import { ProductReviewStatus } from '~enums';
import type { ID } from '~types';

import type { ProductReviewStatusInput } from '../product-review.interfaces';

/**
 * Largest batch one verdict may carry. Deliberately the review screen's own
 * page size: "select the page and verify it" is then a gesture the API was
 * designed for, and nothing larger is a gesture at all. It is a bound on the
 * request rather than a nicety — the verdict is one `UPDATE`, and three
 * thousand ids in its `ANY` would take locks across the whole catalogue in the
 * middle of a sync.
 */
const MAX_IDS = 200;

export class ProductReviewStatusDto implements ProductReviewStatusInput {
  /**
   * The bottlings to decide about. Bulk from the start: a pass over a night's
   * arrivals is twenty decisions, and twenty separate requests against a
   * three-per-second limiter would earn a 429 doing nothing unusual.
   */
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_IDS)
  @IsUUID('all', { each: true })
  public productIds!: ID[];

  @IsEnum(ProductReviewStatus)
  public reviewStatus!: ProductReviewStatus;
}
