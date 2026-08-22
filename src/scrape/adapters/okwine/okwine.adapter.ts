import { ListingStop } from '~enums';
import type {
  ListingResult,
  ProductSnapshot,
  ScrapeProgressReporter,
  StoreScrapeSpec,
} from '~types';

import { isEndOfCatalog } from '../../http/http.util';
import { NormalizeService } from '../../normalize/normalize.service';
import { HttpAdapterBase } from '../scrape-adapter.base';

import type { ScrapeHttpClient } from '../../http/http-client.interfaces';
import type {
  OkwineListing,
  OkwineProduct,
  OkwineProductsData,
} from './okwine.interfaces';

const API = 'https://product.okwine.ua/api/v1/filter/full';

const SITE = 'https://okwine.ua';

/**
 * ObjectId of the "Віскі" category.
 */
const CATEGORY = '61c460bf1fda1bf332a33c09';

/**
 * ObjectId of the city whose warehouse stock is reported (Kyiv).
 */
const CITY = '61e159f3ab2700007200435f';

const JSON_HEADERS = { Accept: 'application/json', Origin: SITE };

/**
 * Backstop against a runaway walk; the category really has ~19 pages.
 */
const MAX_PAGES = 40;

const VOLUME_PATH = 'obiem';

const AGE_PATH = 'vytrymka';

/**
 * OK Wine (okwine.ua) — a Next.js SPA whose listing is loaded over XHR from a
 * public product-service JSON API, so no browser is needed. Volume and age
 * come from the product's characteristics, which are more reliable than
 * parsing them out of the name.
 */
export class OkwineAdapter extends HttpAdapterBase {
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
   * Walks the whisky category page by page, up to the page count the API
   * reports.
   *
   * @returns The store's whisky listing and whether it is the whole listing.
   * @throws {ScrapeHttpError} When the very first page cannot be fetched.
   */
  public async fetchListing(): Promise<ListingResult> {
    const snaps: ProductSnapshot[] = [];
    const seen = new Set<string>();
    let statedItems: number | null = null;
    let received = 0;
    let maxPage: number | null = null;
    let page = 1;

    while (page <= Math.min(maxPage ?? MAX_PAGES, MAX_PAGES)) {
      let block: OkwineProductsData;

      try {
        block = await this.fetchPage(page);
      } catch (error) {
        if (snaps.length === 0) {
          throw error;
        }

        return this.listing(
          snaps,
          isEndOfCatalog(error)
            ? ListingStop.EXHAUSTED
            : ListingStop.PAGE_FAILED,
          statedItems,
          received,
        );
      }

      statedItems ??= this.readCount(block);
      maxPage ??= block.maxPage ?? null;

      const products = block.data ?? [];

      received += products.length;

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
        return this.listing(
          snaps,
          ListingStop.EXHAUSTED,
          statedItems,
          received,
        );
      }

      page += 1;
      await this.sleep();
    }

    /**
     * The loop bound is the lower of the declared page count and the backstop,
     * so falling out of it means either that every declared page was consumed
     * or that the backstop cut the walk short.
     */
    const hitPageCap = maxPage === null || page <= maxPage;

    return this.listing(
      snaps,
      hitPageCap ? ListingStop.PAGE_CAP : ListingStop.EXHAUSTED,
      statedItems,
      received,
    );
  }

  /**
   * Reads the item count the API states for the filtered category.
   *
   * @param block - Any listing page's product block.
   * @returns The item count, or null when it is missing or unusable.
   */
  private readCount(block: OkwineProductsData): number | null {
    const count = block.count;

    return typeof count === 'number' && count > 0 ? count : null;
  }

  /**
   * Fetches one listing page.
   *
   * @param page - 1-based page number.
   * @returns The page's product block.
   */
  private async fetchPage(page: number): Promise<OkwineProductsData> {
    const response = await this.http.get(API, {
      params: { category: CATEGORY, city: CITY, lang: 'ua', page },
      headers: JSON_HEADERS,
    });

    return response.json<OkwineListing>().data?.productsData ?? {};
  }

  /**
   * Maps one API product to a snapshot.
   *
   * @param product - The raw product.
   * @returns The snapshot, or null when the item carries no price.
   */
  private toSnapshot(product: OkwineProduct): ProductSnapshot | null {
    const price = product.prices?.price;

    if (!price) {
      return null;
    }

    const oldPrice = product.prices?.old_price;
    const discounted = Boolean(oldPrice && oldPrice > price);
    const slug = product.url ?? '';
    const id = String(product.id ?? '');
    const characteristics = this.characteristics(product);

    return this.makeSnapshot({
      storeSku: id === '' ? slug : id,
      url: slug ? `${SITE}/ua/product/${slug}` : '',
      name: product.name ?? '',
      price,
      oldPrice: discounted ? Number(oldPrice) : null,
      inStock: product.inStock !== false,
      promo: discounted,
      /**
       * Characteristics beat parsing the name; normalization never overwrites
       * a field the adapter already filled.
       */
      volumeMl: this.normalizer.parseVolumeValue(
        characteristics.get(VOLUME_PATH),
      ),
      ageYears: this.normalizer.extractAgeYears(
        characteristics.get(AGE_PATH) ?? '',
      ),
      rawAttrs: {
        category: 'viski',
        description: product.meta_description ?? '',
      },
    });
  }

  /**
   * Indexes a product's characteristics by slug, keeping the first value of
   * each (`obiem` → `700 мл`).
   *
   * @param product - The raw product.
   * @returns Characteristic slug to value.
   */
  private characteristics(product: OkwineProduct): Map<string, string> {
    const out = new Map<string, string>();

    (product.characteristics ?? []).forEach((characteristic) => {
      const value = characteristic.values?.[0]?.value;

      if (characteristic.path && value) {
        out.set(characteristic.path, value);
      }
    });

    return out;
  }
}
