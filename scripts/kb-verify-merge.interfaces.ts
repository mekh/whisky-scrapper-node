/**
 * One parsed TSV line from a verification batch output, with enough context
 * to name the offending file and line in an error.
 */
export interface VerifyLine {
  /**
   * Batch number the line came from ("01".."19").
   */
  batch: string;

  /**
   * File the line came from, relative to the verify directory.
   */
  file: string;

  /**
   * 1-based line number inside that file.
   */
  line: number;

  /**
   * The tab-separated fields, exactly as read.
   */
  fields: string[];
}

/**
 * One row of the queue the fleet was asked to verify — the stored producer as
 * it was exported into `in/batch-NN.tsv`.
 */
export interface QueueRow {
  /**
   * Batch that owns the slug — the one whose input file lists it.
   */
  batch: string;

  /**
   * The stored row's 15 seed-format fields (slug..note).
   */
  fields: string[];
}

/**
 * A problem the merge found. Errors block the assets; warnings are recorded
 * in the report and let the merge proceed.
 */
export interface MergeIssue {
  /**
   * Whether the issue blocks asset generation.
   */
  level: 'error' | 'warn';

  /**
   * Human-readable description naming file and line where possible.
   */
  message: string;
}
