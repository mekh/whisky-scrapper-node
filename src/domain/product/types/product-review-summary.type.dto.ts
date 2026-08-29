import { IsInt, IsObject } from 'class-validator';

import type { ProductReviewSummary } from '~types';

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
}
