/**
 * Origin country and whisky type inferred from a brand.
 */
export interface BrandDetection {
  /**
   * Origin country (Ukrainian name), or null when the brand is unknown.
   */
  country: string | null;

  /**
   * Whisky type, or null when unknown or the brand spans several types.
   */
  type: string | null;
}
