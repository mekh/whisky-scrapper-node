/**
 * How many products a persist pass stored, added and flagged out of stock.
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
   * Products marked out of stock this pass (rows are kept, never deleted).
   */
  removed: number;
}
