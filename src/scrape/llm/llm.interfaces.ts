import type { FlavorConfidence } from '~types';

/**
 * Per-call overrides for the shared LLM transport. Each field falls back to the
 * configured value, so a pass that needs a different model or reasoning setting
 * than the rest states only that difference.
 */
export interface LlmCallOverrides {
  /**
   * Provider model slug to use for this call.
   */
  model?: string;

  /**
   * Whether the model may spend tokens on reasoning for this call.
   */
  reasoning?: boolean;
}

/**
 * One item put through the flavor-classification pass. `ProductSnapshot`
 * structurally satisfies this shape for new SKUs during a scrape, while the
 * `enrich-flavors` backfill script passes `FlavorCandidateRow` (`~types`) built
 * from stored `product` rows.
 */
export interface LlmFlavorCandidate {
  /**
   * Raw product name — the primary classification input.
   */
  name: string;

  /**
   * Whisky type when known, as extra grounding for the model.
   */
  whiskyType?: string | null;

  /**
   * Country when known, as extra grounding for the model.
   */
  country?: string | null;

  /**
   * Marketing/tasting text when the item carries one directly.
   */
  description?: string | null;

  /**
   * Raw listing attributes; the pass reads `description` out of here, which is
   * where the zakaz and okwine adapters already put the store's own text at no
   * extra request cost.
   */
  rawAttrs?: Record<string, unknown>;

  /**
   * Result slot: the tags the model returned, filtered to the closed
   * vocabulary.
   */
  llmFlavorTags?: string[];

  /**
   * Result slot: the confidence the model reported.
   */
  llmFlavorConfidence?: FlavorConfidence;

  /**
   * Result slot: whether the model answered for this item. Left unset when the
   * batch failed, so the caller can retry instead of recording a false miss.
   */
  llmFlavorChecked?: boolean;
}

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
