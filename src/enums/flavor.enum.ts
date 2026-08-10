/**
 * Which pass produced a `product_flavor` link. Stored as a plain varchar on
 * `product_flavor.source` (not a Postgres enum type, mirroring
 * {@link SyncEngine}), so this enum only pins the values the app writes.
 *
 * The distinction is load-bearing because the two sources have opposite
 * lifetimes. `SCRAPE` rows are re-derived on every sync: the keyword pass
 * matches whatever the listing said this run, and `setFlavors` replaces
 * exactly that source's rows. `LLM` rows come from the dedicated
 * classification pass, are written by `setLlmFlavors` instead, and the sync
 * never touches them — without this column a sync would wipe every LLM
 * answer the next time it ran.
 */
export enum FlavorSource {
  /**
   * The deterministic keyword pass matched this tag in the product name or a
   * raw listing attribute. Replaced wholesale on every sync.
   */
  SCRAPE = 'scrape',
  /**
   * The LLM flavor-classification pass produced this tag. Survives syncs.
   */
  LLM = 'llm',
}

/**
 * Source assigned to rows written before the column existed, and to any link
 * the sync pipeline creates.
 */
export const DEFAULT_FLAVOR_SOURCE = FlavorSource.SCRAPE;
