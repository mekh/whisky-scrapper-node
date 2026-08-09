import type {
  ProductSnapshot,
  ScrapeProgressReporter,
  StoreScrapeSpec,
} from '~types';

import { NormalizeService } from '../../normalize/normalize.service';
import { HttpAdapterBase } from '../scrape-adapter.base';

import type { ScrapeHttpClient } from '../../http/http-client.interfaces';
import type { SilpoListing, SilpoProduct } from './silpo.interfaces';

const SITE = 'https://silpo.ua';

/**
 * The "no branch selected" guest branch. The SPA substitutes a real branch
 * UUID once a city is chosen; the zero UUID answers with the default
 * assortment and stock, which is what a first-time visitor sees.
 */
const DEFAULT_BRANCH = '00000000-0000-0000-0000-000000000000';

const API =
  `https://sf-ecom-api.silpo.ua/v1/uk/branches/${DEFAULT_BRANCH}/products`;

const JSON_HEADERS = {
  Accept: 'application/json',
  Origin: SITE,
  Referer: `${SITE}/`,
};

const CATEGORY = 'viski-4466';

const PAGE_SIZE = 100;

/**
 * Backstop against a runaway walk; the category really has ~11 pages of 100
 * (1069 items on 2026-08-09), and the reported `total` normally ends the walk.
 */
const MAX_PAGES = 40;

/**
 * Silpo (silpo.ua) — the HTML site sits behind an aggressive Cloudflare
 * Turnstile, but its SPA loads the catalog from a separate JSON API host
 * (`sf-ecom-api.silpo.ua`) that answers plain requests, so no browser is
 * needed — the legacy tier-3 classification described the HTML host, not
 * this API. Out-of-stock items stay in the listing with `stock: 0`, which
 * feeds the `inStock` flag directly instead of relying on the persist sweep.
 */
export class SilpoAdapter extends HttpAdapterBase {
  private readonly normalizer: NormalizeService;

  public constructor(
    spec: StoreScrapeSpec,
    delayMultiplier: number,
    http: ScrapeHttpClient,
    normalizer: NormalizeService,
    reporter?: ScrapeProgressReporter,
  ) {
    super(spec, delayMultiplier, http, reporter);

    this.normalizer = normalizer;
  }

  /**
   * Walks the whisky category page by page, up to the page count derived
   * from the total the API reports.
   *
   * @returns The store's whisky listing, out-of-stock items included.
   * @throws {Error} When the very first page cannot be fetched.
   */
  public async fetchListing(): Promise<ProductSnapshot[]> {
    const snaps: ProductSnapshot[] = [];
    const seen = new Set<string>();
    let totalPages: number | null = null;
    let page = 1;

    while (page <= Math.min(totalPages ?? MAX_PAGES, MAX_PAGES)) {
      let listing: SilpoListing;

      try {
        listing = await this.fetchPage(page);
      } catch (error) {
        if (snaps.length === 0) {
          throw error;
        }

        break;
      }

      totalPages ??= this.readTotalPages(listing);

      const fresh = this.freshSnapshots(
        listing.items ?? [],
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

      if (fresh.length === 0) {
        break;
      }

      page += 1;
      await this.sleep();
    }

    return snaps;
  }

  /**
   * Fetches one listing page.
   *
   * @param page - 1-based page number, translated to a `limit`/`offset` pair.
   * @returns The page's listing block.
   */
  private async fetchPage(page: number): Promise<SilpoListing> {
    const response = await this.http.get(API, {
      params: {
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        category: CATEGORY,
      },
      headers: JSON_HEADERS,
    });

    return response.json<SilpoListing>();
  }

  /**
   * Derives the page count from the total item count the API reports.
   *
   * @param listing - Any listing page.
   * @returns The page count, or null when the total is missing or unusable.
   */
  private readTotalPages(listing: SilpoListing): number | null {
    const total = listing.total;

    return typeof total === 'number' && total > 0
      ? Math.ceil(total / PAGE_SIZE)
      : null;
  }

  /**
   * Maps one API product to a snapshot.
   *
   * @param product - The raw product.
   * @returns The snapshot, or null when the item lacks a slug, name or price.
   */
  private toSnapshot(product: SilpoProduct): ProductSnapshot | null {
    const price = product.price;
    const slug = product.slug ?? '';
    const name = product.title ?? '';

    if (!price || slug === '' || name === '') {
      return null;
    }

    const sku = product.externalProductId;
    const oldPrice = product.oldPrice;
    const discounted = Boolean(oldPrice && oldPrice > price);

    return this.makeSnapshot({
      storeSku: sku === null || sku === undefined ? slug : String(sku),
      url: `${SITE}/product/${slug}`,
      name,
      brand: product.brandTitle ?? null,
      price,
      oldPrice: discounted ? Number(oldPrice) : null,
      inStock: (product.stock ?? 0) > 0,
      promo: discounted,
      /**
       * The pack size the site displays beats parsing the name, which
       * carries no volume at all here.
       */
      volumeMl: this.normalizer.parseVolumeValue(product.displayRatio),
      rawAttrs: { category: CATEGORY },
    });
  }
}
