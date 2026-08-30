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
 * How a failed batch should be handled: `transport` re-sends it unchanged,
 * `halve` splits it and retries the halves, `fatal` stops the whole run.
 */
export type LlmErrorKind = 'transport' | 'halve' | 'fatal';

/**
 * Run-level knobs for one `LlmBatchRunner.run` call, kept apart from the
 * per-batch callbacks so a pass states only the ones it cares about.
 */
export interface LlmRunOptions {
  /**
   * How many batches of this run may be in flight at once. Defaults to one,
   * which is the strictly sequential behaviour every caller had before.
   */
  concurrency?: number;

  /**
   * Cooperative deadline. Once it fires, batches not yet started are reported
   * as skipped instead of being sent; a batch already in flight is left to
   * finish, since the answer is already paid for.
   */
  signal?: AbortSignal;
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
   * The resolved distillery's display name, when the knowledge base placed
   * this bottling.
   *
   * This is the grounding that matters most. Asked about
   * `Gordon & MacPhail Ledaig Discovery` the model has to work out whose
   * whisky it is before it can say anything about the flavour; told the
   * distillery outright, it does not have to guess — and guessing from the
   * neighbourhood of a name is exactly what put Ledaig's smoke on Tobermory.
   */
  distillery?: string | null;

  /**
   * The distillery's region, for the same reason.
   */
  region?: string | null;

  /**
   * Tags the producer's curated house style rules out for every bottling.
   *
   * Passed so the answer can be post-filtered against them. Telling the model
   * about them as well would only invite it to argue.
   */
  forbiddenTags?: string[];

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

/**
 * What the research pass proposes for one brand.
 *
 * Every field is a string because it is a proposal, not a fact: it goes
 * through the same validation and the same auto-gate the researched seed went
 * through before any of it reaches a typed column.
 */
export interface LlmResearchResult {
  /**
   * Stable kebab-case key for the producer.
   */
  slug: string;

  /**
   * Display name.
   */
  name: string;

  /**
   * `ProducerKind` value.
   */
  kind: string;

  /**
   * ISO country code.
   */
  countryCode: string;

  /**
   * Common region, `islands` included.
   */
  region: string;

  /**
   * The protected SWA region; never `islands`.
   */
  legalRegion: string;

  /**
   * Owning company.
   */
  owner: string;

  /**
   * The type every bottling of this producer is.
   */
  defaultTypeName: string;

  /**
   * The peat band. The gate treats a positive value far more strictly than
   * `none`, because only a positive one can hide a whisky.
   */
  peatProfile: string;

  /**
   * The distillery a `brand` comes from.
   */
  parentSlug: string;

  /**
   * The model's self-assessed confidence.
   */
  confidence: string;

  /**
   * Space-separated citations.
   */
  sourceUrls: string;

  /**
   * What it was unsure of, and anything withheld.
   */
  note: string;
}

/**
 * One brand the knowledge base does not know, with the evidence available.
 */
export interface LlmResearchCandidate {
  /**
   * The brand name exactly as the catalogue spells it, typos included — that
   * spelling is what has to resolve afterwards.
   */
  brand: string;

  /**
   * How many bottlings carry it, so the worst gaps are researched first.
   */
  productCount: number;

  /**
   * A few of its product names. They are evidence, and often the decisive
   * kind: an independent bottler's samples name the distilleries it bottles.
   */
  sampleNames: string[];

  /**
   * Result slot: what the model proposed.
   */
  result?: LlmResearchResult;

  /**
   * Result slot: whether the model answered, so an unanswered brand is retried
   * rather than recorded as researched.
   */
  checked?: boolean;
}
