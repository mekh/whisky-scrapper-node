import { ReportCurrentRow } from '~types';

/**
 * The three price rules every offer of a bottling is read through, wherever it
 * is rendered.
 *
 * They were private to `ReportService` while the report was the only consumer.
 * The collection shows the same offers beside a bottle a user already owns, and
 * a second copy of "what counts as a discount" is exactly the kind of drift
 * that makes two screens disagree about the same shop's price — so the rules
 * live here and both callers read them.
 */
export class OfferPriceUtils {
  /**
   * The row's own previous price when the price has fallen since, else null.
   *
   * This is what an offer-level discount means on every screen that states one
   * — measured against a price we actually recorded, never the store's
   * advertised strike price.
   *
   * @param row - The current row.
   * @returns The previous price when it beats the current one, else null.
   */
  public static previousDrop(
    row: Pick<ReportCurrentRow, 'price' | 'previousPrice'>,
  ): number | null {
    return row.previousPrice && row.previousPrice > row.price
      ? row.previousPrice
      : null;
  }

  /**
   * Whole-percent discount of a price against a reference.
   *
   * @param current - The current price.
   * @param reference - The reference price, or null.
   * @returns The rounded discount percent, or null when there is no discount.
   */
  public static discountPct(
    current: number,
    reference: number | null,
  ): number | null {
    if (!reference || reference <= 0 || current >= reference) {
      return null;
    }

    return Math.round((reference - current) / reference * 100);
  }

  /**
   * Orders two offers of one bottling by price, then deterministically.
   *
   * The tie-breakers are not cosmetic: the current-rows query has no
   * `ORDER BY` of its own, so two equally priced offers would otherwise swap
   * places between requests, and with them the group's primary offer — the
   * store, URL and history the collapsed row points at.
   *
   * It takes the offer-level fields alone rather than a whole row, because
   * `best` orders its candidates with it before any of them is enriched.
   *
   * @param a - First offer.
   * @param b - Second offer.
   * @returns Negative, zero, or positive per standard comparator semantics.
   */
  public static byPrice(
    a: Pick<ReportCurrentRow, 'id' | 'price' | 'storeName'>,
    b: Pick<ReportCurrentRow, 'id' | 'price' | 'storeName'>,
  ): number {
    return a.price - b.price
      || a.storeName.localeCompare(b.storeName)
      || a.id.localeCompare(b.id);
  }
}
