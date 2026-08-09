/**
 * One entry of the brand match index built from the catalogue's known brand
 * names.
 */
export interface BrandMatchEntry {
  /**
   * The name normalized for matching: lower-cased, apostrophes removed, every
   * non-alphanumeric run collapsed to a single space. Compared against a
   * product name normalized the same way, so "Jack Daniel's" and
   * "Jack Daniels" are the same key.
   */
  key: string;

  /**
   * The canonical brand spelling to store, exactly as the `brand` table holds
   * it.
   */
  name: string;
}

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
