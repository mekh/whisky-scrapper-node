/**
 * One unresolved disagreement, resolved to readable labels.
 */
export interface ConflictRow {
  /**
   * Which fact is disputed.
   */
  attribute: string;

  /**
   * The shop making the claim.
   */
  store: string;

  /**
   * How many syncs have seen the claim.
   */
  seen: number;

  /**
   * Where the catalogue's own value came from.
   */
  storedSource: string;

  /**
   * The bottling's name, for a human reading the queue.
   */
  product: string;

  /**
   * The catalogue's value, resolved to a name or code where the column holds
   * an id.
   */
  stored: string;

  /**
   * The shop's value, resolved the same way.
   */
  claimed: string;
}

/**
 * One shop's disagreement rate.
 */
export interface StoreRateRow {
  /**
   * The shop's slug.
   */
  store: string;

  /**
   * How many distinct bottlings it contradicts.
   */
  products: number;

  /**
   * How many sightings those contradictions account for.
   */
  seen: number;

  /**
   * How many in-stock listings the shop carries, the denominator that makes
   * the rate comparable between a large shop and a small one.
   */
  listings: number;
}
