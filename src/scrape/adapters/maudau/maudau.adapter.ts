import type { ProductSnapshot } from '~types';

import { HttpAdapterBase } from '../scrape-adapter.base';

import type { MaudauProduct } from './maudau.interfaces';

const API = 'https://backend.prod.maudau.click/v1/user/products/searches';

const SITE = 'https://maudau.com.ua';

const JSON_HEADERS = {
  Accept: 'application/json',
  Origin: SITE,
  Referer: `${SITE}/`,
};

const CATEGORY = 'viski';

const PER_PAGE = 48;

/**
 * Backstop against a runaway walk if the paging headers ever disappear.
 */
const MAX_PAGES = 80;

/**
 * Sorted by popularity, the available items form one solid prefix and the
 * unavailable tail brings nothing: stop after this many consecutive pages
 * without a new snapshot. Above 1 to absorb a single odd page (a duplicate
 * page while the catalog reshuffles) without giving up reliability.
 */
const EARLY_STOP_EMPTY_PAGES = 2;

const KOPECKS = 100;

const TOTAL_PAGES_HEADER = 'x-total-pages';

const LAST_PAGE_HEADER = 'x-last-page';

/**
 * MauDau (maudau.com.ua) — full catalog coverage through the marketplace's
 * internal JSON API, which paginates correctly (unlike `?page=N` on the site
 * itself) and reports the page count in its headers, so nothing is guessed and
 * no browser is needed. The `viski` category holds ~2500 SKUs including
 * unavailable ones; only the ~780 available items are kept.
 */
export class MaudauAdapter extends HttpAdapterBase {
  /**
   * Walks the whisky category through the catalog API, keeping the available
   * items only.
   *
   * @returns The store's live whisky listing.
   * @throws {Error} When the API cannot be reached. The Python adapter falls
   * back to parsing the first listing page out of the Next.js RSC payload;
   * that fallback is deliberately not ported yet.
   */
  public async fetchListing(): Promise<ProductSnapshot[]> {
    const snaps: ProductSnapshot[] = [];
    const seen = new Set<string>();
    let totalPages: number | null = null;
    let emptyStreak = 0;
    let page = 1;

    while (page <= Math.min(totalPages ?? MAX_PAGES, MAX_PAGES)) {
      const response = await this.http.get(API, {
        params: {
          category_slug: CATEGORY,
          page,
          per_page: PER_PAGE,
          sort_field: 'popularity_index',
          sort_direction: 'DESC',
        },
        headers: JSON_HEADERS,
      });

      totalPages ??= this.readTotalPages(response.headers);

      const products = response.json<MaudauProduct[]>();

      if (!Array.isArray(products) || products.length === 0) {
        break;
      }

      const fresh = this.freshSnapshots(
        products,
        seen,
        (product) => this.toSnapshot(product),
      );

      fresh.forEach((snap) => seen.add(snap.storeSku));
      snaps.push(...fresh);
      this.emit({
        kind: 'page',
        page,
        added: fresh.length,
        total: snaps.length,
      });

      if (response.headers[LAST_PAGE_HEADER]?.toLowerCase() === 'true') {
        break;
      }

      emptyStreak = fresh.length === 0 ? emptyStreak + 1 : 0;

      if (emptyStreak >= EARLY_STOP_EMPTY_PAGES) {
        break;
      }

      page += 1;
      await this.sleep();
    }

    return snaps;
  }

  /**
   * Reads the total page count the API reports.
   *
   * @param headers - Response headers of a listing page.
   * @returns The page count, or null when the header is missing or unusable.
   */
  private readTotalPages(headers: Record<string, string>): number | null {
    const raw = Number(headers[TOTAL_PAGES_HEADER]);

    return Number.isInteger(raw) && raw > 0 ? raw : null;
  }

  /**
   * Maps one API product to a snapshot.
   *
   * @param product - The raw product.
   * @returns The snapshot, or null when the item is unavailable or priceless.
   */
  private toSnapshot(product: MaudauProduct): ProductSnapshot | null {
    const offer = product.offer ?? {};
    const price = offer.price;

    /**
     * Only the live catalog is kept: an unavailable item is not an offer.
     */
    if (price === null || price === undefined || !offer.available) {
      return null;
    }

    const oldPrice = offer.old_price;

    return this.makeSnapshot({
      storeSku: String(product.id),
      url: `${SITE}/product/${product.slug}`,
      name: product.title,
      brand: product.brand?.slug ?? null,
      price: price / KOPECKS,
      oldPrice: oldPrice ? oldPrice / KOPECKS : null,
      inStock: true,
      promo: Boolean(oldPrice && oldPrice > price),
      rawAttrs: {
        category: product.main_category_slug,
        discount_percentage: offer.discount_percentage,
      },
    });
  }
}
