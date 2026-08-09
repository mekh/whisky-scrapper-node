import type {
  ProductSnapshot,
  ScrapeProgressReporter,
  StoreScrapeSpec,
} from '~types';

import { NormalizeService } from '../../normalize/normalize.service';
import { HttpAdapterBase } from '../scrape-adapter.base';

import type { ScrapeHttpClient } from '../../http/http-client.interfaces';
import type {
  ZakazListing,
  ZakazProduct,
  ZakazStore,
} from './zakaz.interfaces';

const API = 'https://stores-api.zakaz.ua';

const JSON_HEADERS = { Accept: 'application/json', 'Accept-Language': 'uk' };

const MAX_PAGES = 40;

const KOPECKS = 100;

const DEFAULT_CATEGORY = 'whiskey';

/**
 * Zakaz.ua — one JSON API shared by dozens of chains (Novus, Metro, Auchan,
 * ...). Every chain returns the same product shape: price in kopecks,
 * `discount.old_price` as the previous price, `volume` in millilitres,
 * `producer.trademark` as the brand. One adapter serves them all; which chain
 * and category to walk comes from `store_config`, so no per-store subclass is
 * needed.
 */
export class ZakazAdapter extends HttpAdapterBase {
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
   * The chain to collect; falls back to the slug, which matches for every
   * chain configured today.
   */
  private get retailChain(): string {
    return this.spec.retailChain ?? this.slug;
  }

  /**
   * The whisky category slug of this chain (`novus` is the historical
   * exception that kept the bare `whiskey`).
   */
  private get category(): string {
    return this.spec.category ?? DEFAULT_CATEGORY;
  }

  /**
   * Walks the chain's whisky category page by page until a page brings
   * nothing new.
   *
   * @returns The chain's whisky listing.
   * @throws {Error} When the very first page cannot be fetched.
   */
  public async fetchListing(): Promise<ProductSnapshot[]> {
    const storeId = await this.resolveStoreId();
    const url = `${API}/stores/${storeId}/categories/${this.category}`
      + '/products/';
    const snaps: ProductSnapshot[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      let products: ZakazProduct[];

      try {
        products = await this.fetchPage(url, page);
      } catch (error) {
        if (snaps.length === 0) {
          throw error;
        }

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

      if (fresh.length === 0) {
        break;
      }

      await this.sleep();
    }

    return snaps;
  }

  /**
   * Resolves the first outlet of this chain — prices barely differ between a
   * chain's stores.
   *
   * @returns The store id used in listing URLs.
   * @throws {Error} When the chain has no store in the directory.
   */
  private async resolveStoreId(): Promise<string> {
    const response = await this.http.get(`${API}/stores/`, {
      headers: JSON_HEADERS,
    });
    const stores = response.json<ZakazStore[]>();
    const match = stores.find(
      (store) => store.retail_chain === this.retailChain,
    );

    if (!match) {
      throw new Error(
        `No ${this.retailChain} store found in the Zakaz.ua directory`,
      );
    }

    return match.id;
  }

  /**
   * Fetches one listing page.
   *
   * @param url - The category listing URL.
   * @param page - 1-based page number.
   * @returns The page's raw products.
   */
  private async fetchPage(
    url: string,
    page: number,
  ): Promise<ZakazProduct[]> {
    const response = await this.http.get(url, {
      params: { page },
      headers: JSON_HEADERS,
    });

    return response.json<ZakazListing>().results ?? [];
  }

  /**
   * Maps one API product to a snapshot.
   *
   * @param product - The raw product.
   * @returns The snapshot, or null when the item carries no price.
   */
  private toSnapshot(product: ZakazProduct): ProductSnapshot | null {
    const price = product.price;

    if (price === null || price === undefined) {
      return null;
    }

    const discount = product.discount ?? {};
    const oldPrice = discount.status ? discount.old_price : null;
    const ean = String(product.ean ?? '');

    return this.makeSnapshot({
      storeSku: ean === '' ? String(product.sku) : ean,
      /**
       * `?? ''` is not enough here: some chains send an explicit null
       * `web_url`, and both url and name are NOT NULL columns.
       */
      url: product.web_url ?? '',
      name: product.title ?? '',
      brand: product.producer?.trademark ?? null,
      price: price / KOPECKS,
      oldPrice: oldPrice ? oldPrice / KOPECKS : null,
      inStock: product.in_stock === undefined
        ? true
        : Boolean(product.in_stock),
      promo: Boolean(oldPrice),
      volumeMl: product.volume ? Math.trunc(product.volume) : null,
      /**
       * The API often reports the umbrella "Великобританія"; collapsing it to
       * null lets normalization pin Scotland/England/Wales from the brand.
       */
      country: this.normalizer.canonicalCountry(product.country),
      rawAttrs: {
        category: 'viski',
        discount_percentage: discount.value,
        description: product.description ?? '',
      },
    });
  }
}
