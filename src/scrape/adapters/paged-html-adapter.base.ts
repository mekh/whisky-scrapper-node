import { load } from 'cheerio';

import type { ProductSnapshot } from '~types';

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
   * Walks the listing until a page yields no new SKU.
   *
   * @returns The store's whisky listing.
   * @throws {Error} When the first page cannot be fetched.
   */
  public async fetchListing(): Promise<ProductSnapshot[]> {
    const snaps: ProductSnapshot[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= this.maxPages; page += 1) {
      const html = await this.loadPage(page, snaps.length === 0);

      if (html === null) {
        break;
      }

      const fresh = this.parsePage(html, seen);

      fresh.forEach((snap) => seen.add(snap.storeSku));
      snaps.push(...fresh);

      this.emit({
        kind: 'page',
        page,
        added: fresh.length,
        total: snaps.length,
      });

      if (fresh.length === 0) {
        break;
      }

      await this.sleep();
    }

    return snaps;
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
   * Fetches one page, turning a tolerable failure into an end-of-walk signal.
   *
   * @param page - 1-based page number.
   * @param required - True while nothing has been collected yet, in which case
   *   the failure is rethrown instead of ending the walk.
   * @returns The page's HTML, or null when the walk should stop.
   * @throws {Error} When a required page cannot be fetched.
   */
  private async loadPage(
    page: number,
    required: boolean,
  ): Promise<string | null> {
    try {
      return await this.fetchPage(page);
    } catch (error) {
      if (required) {
        throw error;
      }

      return null;
    }
  }

  /**
   * Parses one page's cards, keeping only SKUs not seen on earlier pages.
   *
   * @param html - The page's HTML.
   * @param seen - SKUs collected so far.
   * @returns The page's new snapshots.
   */
  private parsePage(
    html: string,
    seen: ReadonlySet<string>,
  ): ProductSnapshot[] {
    const $ = load(html);

    return this.freshSnapshots(
      $(this.cardSelector).toArray(),
      seen,
      (card) => this.parseCard($, card),
    );
  }
}
