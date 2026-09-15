import { Type } from 'class-transformer';
import { IsInt, ValidateNested } from 'class-validator';

import { ProductReviewCountsType } from './product-review-counts.type.dto';

/**
 * What a reviewer's verdict wrote, plus the fresh queue counters.
 *
 * The counters ride along because they are exactly what changes on the
 * screen's tab badge and its segment chips — a client would otherwise re-read
 * the summary after every decision, which is the round trip the response's
 * own shape can save.
 */
export class ProductReviewStatusResultType {
  /**
   * How many rows the verdict actually wrote. Lower than the request's id
   * count when some were already in that state.
   */
  @IsInt()
  public updated!: number;

  @ValidateNested()
  @Type(() => ProductReviewCountsType)
  public products!: ProductReviewCountsType;
}
