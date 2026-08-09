/**
 * One item put through the name-extraction pass. `ProductSnapshot`
 * structurally satisfies this shape, so `ScrapeService` passes snapshots
 * straight through, while the `clean-product-names` backfill script builds
 * plain candidates from stored `product` rows.
 */
export interface LlmNameCandidate {
  /**
   * Raw product name to extract the brand + expression from.
   */
  name: string;

  /**
   * Result slot, filled in place with the brand + expression once the model
   * returns a value that passes validation. Left untouched when the pass is
   * disabled, the call fails, or the candidate is rejected — the caller then
   * falls back to `ProductNameUtils.clean`.
   */
  cleanName?: string | null;
}
