/**
 * Which pass produced a `product_flavor` link. Stored as a plain varchar on
 * `product_flavor.source` (not a Postgres enum type, mirroring
 * {@link SyncEngine}), so this enum only pins the values the app writes.
 *
 * The distinction is load-bearing because the sources have different
 * lifetimes. `SCRAPE` rows are contributed by the keyword pass on every sync,
 * which only ever adds. `LLM` rows come from the dedicated classification
 * pass, are written by `setLlmFlavors` instead, and the sync never touches
 * them — without this column a sync would wipe every LLM answer the next time
 * it ran. `KB` rows are derived from the curated knowledge base and are the
 * only source allowed to state peat. `MANUAL` rows are a person's decision and
 * outrank all of them.
 */
export enum FlavorSource {
  /**
   * The deterministic keyword pass matched this tag in the product name or a
   * raw listing attribute. Contributed on every sync, never removed by one.
   */
  SCRAPE = 'scrape',
  /**
   * The LLM flavor-classification pass produced this tag. Survives syncs.
   */
  LLM = 'llm',
  /**
   * Derived deterministically from the knowledge base: a producer's peat
   * profile, a curated house-style row, or a name-pattern rule.
   *
   * For `peated` and `smoky` this is the **only** automatic source there is —
   * both tags were taken out of the keyword vocabulary and out of the LLM's
   * prompt, so after reconciliation every peat link in the database is either
   * `KB` or `MANUAL`. That invariant is what makes "exclude peated" safe to
   * trust: a plausible-but-wrong peat tag silently removed the user's
   * favourite whisky from every result, and no amount of prompt tuning could
   * rule that out.
   */
  KB = 'kb',
  /**
   * Someone set this tag by hand through `POST /product/update`. A manual edit
   * replaces the bottling's whole tag set and stamps the bottling's
   * `flavorsCuratedAt`, which locks both automatic passes out of it for good —
   * otherwise the next sync's keyword pass would put back the very tags the
   * person had just removed.
   */
  MANUAL = 'manual',
}

/**
 * Source assigned to rows written before the column existed, and to any link
 * the sync pipeline creates.
 */
export const DEFAULT_FLAVOR_SOURCE = FlavorSource.SCRAPE;
