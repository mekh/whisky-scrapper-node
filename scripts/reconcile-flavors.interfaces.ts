/**
 * What a reconciliation run was asked to do.
 */
export interface ReconcileOptions {
  /**
   * Build and report the plan without writing any of it.
   */
  dryRun: boolean;

  /**
   * Where to dump the per-bottling diff as a TSV, when asked for one.
   */
  out?: string;

  /**
   * Narrow the pass to bottlings a single store lists, for a spot check.
   */
  store?: string;

  /**
   * Narrow the pass to a single brand name.
   */
  brand?: string;

  /**
   * Leave the peat links of a bottling that resolved to nothing alone.
   *
   * Off by default, and that default is the product decision: an unresolved
   * bottling states nothing about peat, so keeping a model's guess is exactly
   * how a whisky goes missing from a filtered result. The flag exists to stage
   * a rollout — apply the facts first, remove the guesses once the seed
   * covers enough of the catalogue.
   */
  keepUnknownPeat: boolean;

  /**
   * Also print the cross-shop contradiction queue.
   */
  reportAttrConflicts: boolean;
}
