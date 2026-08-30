import type {
  ID,
  KbApplyPlan,
  KbProducerFacts,
  KbReconcileRow,
  KbReconcileSummary,
} from '~types';

/**
 * The pair of entities a product name resolves to: whose spirit it is, and who
 * released it. Either may be null, and both being null is a valid answer — an
 * undisclosed bottling states neither.
 */
export interface KbProducerMatch {
  /**
   * The distillery, brand or blend the liquid comes from.
   */
  producer: KbProducerFacts | null;

  /**
   * The independent bottler that released it.
   */
  bottler: KbProducerFacts | null;
}

/**
 * What to narrow a reconciliation pass to, and whether to write it.
 */
export interface KbReconcileRequest {
  /**
   * Build the plan and report it without writing any of it.
   */
  dryRun?: boolean;

  /**
   * Narrow to bottlings a single store lists, for a spot check.
   */
  store?: string;

  /**
   * Narrow to one brand name, likewise.
   */
  brand?: string;

  /**
   * Narrow to specific bottlings.
   */
  ids?: ID[];

  /**
   * Leave the peat links of unresolved bottlings alone. See
   * {@link KbApplyOptions.keepUnknownPeat}.
   */
  keepUnknownPeat?: boolean;
}

/**
 * One pass's plan, the rows it was built from, and what it wrote.
 *
 * The plan and rows come back because the CLI reports a per-bottling diff from
 * them; the HTTP caller reads only the summary.
 */
export interface KbReconcileRun {
  /**
   * Everything the pass decided.
   */
  plan: KbApplyPlan;

  /**
   * The bottlings the plan was built from.
   */
  rows: KbReconcileRow[];

  /**
   * The numbers both callers report.
   */
  summary: KbReconcileSummary;
}
