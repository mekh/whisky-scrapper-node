/**
 * How far a bottling has been through the new-product queue.
 *
 * A sync mints a `product` row from whatever a shop printed, and the name
 * cleaner, the age reader and the flavour passes all guess. Roughly one row in
 * fifty needs a person: a truncated name, an age read out of prose, a gift set
 * recorded as one bottle — or something that is not whisky at all. This column
 * is the work queue that puts each new row in front of one.
 *
 * Stored as a `varchar(16)` with no Postgres enum type and no CHECK, exactly
 * as {@link KbStatus} is: that is what let `rejected` be added to the
 * knowledge base's own vocabulary later with no migration at all, and a fourth
 * value here should cost the same.
 *
 * **`NULL` is the fourth state, and it is the load-bearing one:** this
 * bottling never entered the workflow. Every row that predates the queue is
 * null, because enrolling the whole catalogue at once is a separate decision
 * with its own window — see the enqueue script. So a predicate over this
 * column must use `IS DISTINCT FROM` rather than `<>`: `NULL <> 'rejected'` is
 * `NULL`, which fails an `AND` and would hide the entire pre-existing
 * catalogue from every report.
 */
export enum ProductReviewStatus {
  /**
   * A sync created the row and nobody has looked at it. The column default, so
   * every insert path — the batch upsert, the two unmatched paths, and any
   * future one — enrols its rows without naming the column at all.
   *
   * Deliberately **not** a quarantine: a pending bottling is in the catalogue
   * like any other. The queue is a list of things to check, not a gate.
   */
  PENDING = 'pending',
  /**
   * A person has looked at the row. The same word `producer.status` already
   * uses for the same act, so the two review screens share one vocabulary.
   *
   * Also stamped by `POST /product/update` when the edited bottling is
   * `pending`: correcting a parse error *is* the review, and a second click to
   * say so is a click somebody forgets.
   */
  VERIFIED = 'verified',
  /**
   * A person ruled the row out — most often because it is not whisky (a
   * liqueur, a cocktail, a bag of drink ice a shop files under whisky).
   *
   * A decision, not a deletion, exactly as {@link KbStatus.REJECTED} is: the
   * row stays, so the verdict is auditable and reversible from the same
   * screen, its offers keep being scraped and its price history keeps
   * growing — only the catalogue reads hide it. Which is also why a later
   * listing of the same thing lands back on this row rather than minting a
   * fresh one: the row stays in key and identity resolution, so a sync can
   * never resurrect what was rejected.
   */
  REJECTED = 'rejected',
}
