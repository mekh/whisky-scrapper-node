/**
 * Why a listing walk stopped. The reason is what decides whether the run is
 * allowed to sweep: an adapter that consumed the source's whole listing proves
 * that anything it did not see is genuinely gone, while an adapter that gave up
 * early proves nothing at all.
 *
 * Not persisted — it lives only for the length of a run, in the run's log file
 * and in the `sync_log.error` text of an incomplete run.
 */
export enum ListingStop {
  /**
   * The source's last page was consumed: it answered with an end-of-catalog
   * signal (a 404/410 past the end, an explicit last-page marker, or a page
   * carrying no SKU the walk had not already collected).
   */
  EXHAUSTED = 'exhausted',
  /**
   * The source stated how many items the category holds and the walk collected
   * exactly that many. The strongest completeness evidence available.
   */
  COUNTED = 'counted',
  /**
   * A page failed for a reason that is not end-of-catalog — a 5xx, a 429, a
   * network error. Whatever the walk had collected up to that point is a
   * fragment of the listing, not the listing.
   */
  PAGE_FAILED = 'page-failed',
  /**
   * The walk hit its `MAX_PAGES` backstop, so the source may well have had
   * more pages to give.
   */
  PAGE_CAP = 'page-cap',
  /**
   * The walk ran to the end of the pages the source declared, but collected
   * fewer items than the source said the category holds.
   */
  SHORT = 'short',
  /**
   * The walk stopped on a signal that means end-of-catalog most of the time
   * and a transient hiccup the rest of it — an empty page from a source that
   * states no total, a run of pages with nothing new. Treated as incomplete:
   * the sweep is the one thing that must not act on a guess.
   */
  AMBIGUOUS = 'ambiguous',
}
