import { Type } from 'class-transformer';
import { IsInt, IsObject, ValidateNested } from 'class-validator';

import type { ProductReviewSummary } from '~types';

import { ProductReviewCountsType } from './product-review-counts.type.dto';

export class ProductReviewSummaryType implements ProductReviewSummary {
  /**
   * Producers by review status, as a flat object rather than a nested DTO —
   * the three counters are the whole shape and a class for them would only add
   * a file.
   */
  @IsObject()
  public producers!: {
    verified: number;
    auto: number;
    unverified: number;
    rejected: number;
  };

  @IsInt()
  public untrustedTypes!: number;

  @IsInt()
  public untrustedCountries!: number;

  @IsInt()
  public untrustedFacts!: number;

  @IsInt()
  public untrustedFactsUnresolved!: number;

  @IsInt()
  public openConflicts!: number;

  @IsInt()
  public unresolvedBrands!: number;

  /**
   * Bottlings by their place in the new-product queue. A nested DTO rather
   * than `producers`' flat object, because this one is served by the review
   * mutation too and the two must not be able to drift.
   */
  @ValidateNested()
  @Type(() => ProductReviewCountsType)
  public products!: ProductReviewCountsType;
}
