import { load } from 'cheerio';

import { ListingStop } from '~enums';
import type { ListingResult, ProductSnapshot } from '~types';

import { isEndOfCatalog } from '../http/http.util';

import { HttpAdapterBase } from './scrape-adapter.base';

import type { CheerioAPI } from 'cheerio';
import type { HtmlNode } from '../html/html.interfaces';

/**
 * Base for the server-rendered HTML stores (WooCommerce, Magento): walk the
 * listing page by page, parse every product card, and stop as soon as a page
 * brings nothing new. Ported from the Python adapters' shared shape, including
 * their failure rule — a page that cannot be fetched ends the walk if anything
 * was collected already, and propagates otherwise (a first-page block must be
 * a loud failure, not a silently empty catalog).
 *
 * What the port did not have is the distinction between the two ways a page
 * can fail. None of these stores states a total, so asking for the page past
 * the end is the only way to learn where the catalogue ends — and several
 * answer it with a 404, which is an answer. A 5xx or a dropped connection is
 * not: the walk holds a fragment, and says so, so persist declines to sweep.
 *
 * A store may also declare a page to be the listing's end itself via
 * {@link pageEndsListing} — the winebutik case, whose listing sorts the
 * purchasable items strictly ahead of a sold-out tail dozens of pages long,
 * so the first sold-out card is the end of everything the walk is for.
 */
export abstract class PagedHtmlAdapterBase extends HttpAdapterBase {
  /**
   * Selector matching one product card on a listing page.
   */
  protected abstract readonly cardSelector: string;

  /**
   * Backstop against a runaway walk; every store's catalog is well under it.
   */
  protected abstract readonly maxPages: number;

  /**
   * Walks the listing until a page yields no new SKU or declares itself the
   * end (see {@link pageEndsListing}).
   *
   * @returns The store's whisky listing and whether the walk reached its end.
   * @throws {ScrapeHttpError} When the first page cannot be fetched.
   */
  public async fetchListing(): Promise<ListingResult> {
    const snaps: ProductSnapshot[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= this.maxPages; page += 1) {
      let html: string;

      try {
        html = await this.fetchPage(page);
      } catch (error) {
        if (snaps.length === 0) {
          throw error;
        }

        return this.listing(
          snaps,
          isEndOfCatalog(error)
            ? ListingStop.EXHAUSTED
            : ListingStop.PAGE_FAILED,
        );
      }

      const $ = load(html);
      const fresh = this.parsePage($, seen);

      fresh.forEach((snap) => seen.add(snap.storeSku));
      snaps.push(...fresh);

      this.emit({
        kind: 'page',
        page,
        added: fresh.length,
        total: snaps.length,
      });

      if (fresh.length === 0 || this.pageEndsListing($)) {
        return this.listing(snaps, ListingStop.EXHAUSTED);
      }

      await this.sleep();
    }

    return this.listing(snaps, ListingStop.PAGE_CAP);
  }

  /**
   * Fetches one listing page's HTML.
   *
   * @param page - 1-based page number.
   * @returns The page's HTML.
   */
  protected abstract fetchPage(page: number): Promise<string>;

  /**
   * Maps one product card to a snapshot.
   *
   * @param $ - Cheerio root of the listing page.
   * @param card - The card node.
   * @returns The snapshot, or null when the card is not a usable product.
   */
  protected abstract parseCard(
    $: CheerioAPI,
    card: HtmlNode,
  ): ProductSnapshot | null;

  /**
   * Whether this page is the end of the useful listing even though it still
   * yielded new SKUs. Consulted after the page is parsed; a true ends the
   * walk with the page's items kept and counts as having consumed the whole
   * listing, exactly like running out of pages does.
   *
   * The default is that no page ever is — only a store whose listing carries
   * an explicit end marker (a sold-out tail on an availability-sorted source)
   * overrides this, so everything the marker trails can be skipped instead of
   * walked and thrown away.
   *
   * @param _$ - Cheerio root of the listing page; unused by the default.
   * @returns True when the walk must not fetch another page.
   */
  protected pageEndsListing(_$: CheerioAPI): boolean {
    return false;
  }

  /**
   * Parses one page's cards, keeping only SKUs not seen on earlier pages.
   *
   * @param $ - Cheerio root of the listing page.
   * @param seen - SKUs collected so far.
   * @returns The page's new snapshots.
   */
  private parsePage(
    $: CheerioAPI,
    seen: ReadonlySet<string>,
  ): ProductSnapshot[] {
    return this.freshSnapshots(
      $(this.cardSelector).toArray(),
      seen,
      (card) => this.parseCard($, card),
    );
  }
}
