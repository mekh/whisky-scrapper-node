/**
 * How many products a persist pass stored, added and removed.
 */
export interface PersistCounts {
  /**
   * In-stock products upserted this pass.
   */
  stored: number;

  /**
   * How many of the stored products were new.
   */
  added: number;

  /**
   * Out-of-stock products removed this pass.
   */
  removed: number;
}
