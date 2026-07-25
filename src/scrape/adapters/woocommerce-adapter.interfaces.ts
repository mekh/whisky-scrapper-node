/**
 * The two prices a WooCommerce listing card can carry, for a single bottle.
 */
export interface WooCommercePrices {
  /**
   * The price actually charged today, or null when the card has none (an
   * enquiry-only item, which is dropped).
   */
  price: number | null;

  /**
   * The struck-through previous price, or null when the item is not on
   * promotion.
   */
  oldPrice: number | null;
}
