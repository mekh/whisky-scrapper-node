export interface TypePaginated<T> {
  /**
   * Data itself
   */
  data: T[];
  /**
   * Total number of items available
   */
  total: number;
  /**
   * Limit that was used in the request
   */
  limit: number;
  /**
   * Offset that was used in the request
   */
  offset: number;
}
