/**
 * Alert threshold for the persist out-of-stock sweep: a run whose in-stock item
 * count falls below this fraction of the store's currently in-stock offers is
 * logged as a sharp drop for an operator to look at.
 *
 * It does **not** gate the sweep. It used to, and could not tell a store whose
 * stock really collapsed from a scrape that broke — see
 * `ScrapePersistService.flagOutOfStock`, which now gates on whether the listing
 * walk reached the end of the source's listing.
 */
export const PERSIST_SWEEP_GUARD_RATIO = 0.5;
