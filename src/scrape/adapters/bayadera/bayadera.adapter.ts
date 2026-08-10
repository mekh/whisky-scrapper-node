import type {
  ProductSnapshot,
  ScrapeProgressReporter,
  StoreScrapeSpec,
} from '~types';

import { firstText } from '../../html/html.util';
import { parsePrice } from '../../http/parse-price.util';
import { NormalizeService } from '../../normalize/normalize.service';
import { PagedHtmlAdapterBase } from '../paged-html-adapter.base';

import type { CheerioAPI } from 'cheerio';
import type { HtmlNode } from '../../html/html.interfaces';
import type { ScrapeHttpClient } from '../../http/http-client.interfaces';
import type { BayaderaProductInfo } from './bayadera.interfaces';

const SITE = 'https://bayadera.ua';

const LISTING = `${SITE}/category/strong-alcohol/whiskey`;

/**
 * Listing cards only: a card in the "top sales" slider sits in a wrapper
 * carrying the extra `slide` class. The slider repeats products from other
 * listing pages (SKU dedup would drop them anyway) but is not scoped to the
 * category, so it must not feed the walk.
 */
const CARD_SELECTOR = 'div.goodWr.goodJs:not(.slide) div.goodHoverJs';

const BUY_BUTTON_SELECTOR = 'button.addToCartBtnModJs';

const OLD_PRICE_SELECTOR = '.goodCost.old';

const PAGE_PARAM = 'page';

const CATEGORY = 'whiskey';

/**
 * `data-product-info` prices are integer kopecks.
 */
const KOPECKS_PER_UAH = 100;

/**
 * The category word the store prepends to some brand values
 * (`Віскі Glenmorangie`); stripped so the brand lookup does not mint a
 * second row beside the clean spelling other stores use.
 */
const BRAND_CATEGORY_PREFIX = /^віскі(?:\s+|$)/i;

/**
 * An attribute value that is exactly a strength (`40%`, `63,4%`).
 */
const ABV_ATTRIBUTE = /^\d{1,2}(?:[.,]\d{1,2})?\s*%$/;

/**
 * Backstop against a runaway walk. The catalog is ~6 pages of 24; a page
 * past the end answers 200 with fallback products repeated from earlier
 * pages, so the walk ends via SKU dedup, not via an empty page.
 */
const MAX_PAGES = 25;

/**
 * Parses the buy button's `data-product-info` JSON.
 *
 * @param raw - The attribute value, already entity-decoded by cheerio.
 * @returns The parsed payload, or an empty object when absent or invalid.
 */
function readInfo(raw: string | undefined): BayaderaProductInfo {
  if (raw === undefined || raw === '') {
    return {};
  }

  try {
    return JSON.parse(raw) as BayaderaProductInfo;
  } catch {
    return {};
  }
}

/**
 * Reads a card's SKU: the article code, falling back to the numeric id.
 *
 * @param info - The card's payload.
 * @returns The SKU, or null when the payload offers neither.
 */
function readSku(info: BayaderaProductInfo): string | null {
  const article = (info.article ?? '').trim();

  if (article !== '') {
    return article;
  }

  const id = info.id;

  return id === null || id === undefined || String(id).trim() === ''
    ? null
    : String(id).trim();
}

/**
 * Reads a card's current price in hryvnia.
 *
 * @param info - The card's payload.
 * @returns The price, or null when missing or unusable.
 */
function readPrice(info: BayaderaProductInfo): number | null {
  const kopecks = Number(info.price);

  return Number.isFinite(kopecks) && kopecks > 0
    ? kopecks / KOPECKS_PER_UAH
    : null;
}

/**
 * Reads a card's brand with the category-word prefix stripped.
 *
 * @param info - The card's payload.
 * @returns The brand, or null when absent or empty after stripping.
 */
function readBrand(info: BayaderaProductInfo): string | null {
  const brand = (info.brand ?? '').replace(BRAND_CATEGORY_PREFIX, '').trim();

  return brand === '' ? null : brand;
}

/**
 * Bayadera (bayadera.ua) — the Bayadera Group's own shop, custom platform,
 * fully server-rendered and reachable with plain HTTP. Every listing card
 * carries the whole item as JSON in its buy button's `data-product-info`
 * attribute (SKU, name, kopeck price, link, volume, characteristic values),
 * plus `data-is-in-stock` — out-of-stock items stay listed, which feeds the
 * `inStock` flag directly. Only the pre-discount price lives outside the
 * JSON, as the struck-through `.goodCost.old` text. Pagination is `?page=N`.
 */
export class BayaderaAdapter extends PagedHtmlAdapterBase {
  protected readonly cardSelector = CARD_SELECTOR;

  protected readonly maxPages = MAX_PAGES;

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
   * Fetches one listing page.
   *
   * @param page - 1-based page number.
   * @returns The page's HTML.
   */
  protected async fetchPage(page: number): Promise<string> {
    const response = await this.http.get(
      LISTING,
      page === 1 ? undefined : { params: { [PAGE_PARAM]: page } },
    );

    return response.text();
  }

  /**
   * Maps one product card to a snapshot, reading everything from the buy
   * button's `data-product-info` JSON except the pre-discount price, which
   * only exists as the struck-through text.
   *
   * @param $ - Cheerio root of the listing page.
   * @param card - The card node.
   * @returns The snapshot, or null when the card lacks a SKU, name or price.
   */
  protected parseCard($: CheerioAPI, card: HtmlNode): ProductSnapshot | null {
    const button = $(card).find(BUY_BUTTON_SELECTOR).first();
    const info = readInfo(button.attr('data-product-info'));
    const sku = readSku(info);
    const name = (info.name ?? '').trim();
    const price = readPrice(info);

    if (sku === null || name === '' || price === null) {
      return null;
    }

    const oldPrice = parsePrice(firstText($, card, OLD_PRICE_SELECTOR));
    const promo = oldPrice !== null && oldPrice > price;
    const link = (info.link ?? '').trim();
    const attributes = (info.attributes ?? [])
      .filter((value): value is string => typeof value === 'string');

    return this.makeSnapshot({
      storeSku: sku,
      url: link === '' ? '' : `${SITE}${link}`,
      name,
      brand: readBrand(info),
      price,
      oldPrice: promo ? oldPrice : null,
      promo,
      inStock: button.attr('data-is-in-stock') !== '0',
      volumeMl: this.normalizer.parseVolumeValue(info.volume),
      abv: this.abvFromAttributes(attributes),
      rawAttrs: { category: CATEGORY, attributes: attributes.join(', ') },
    });
  }

  /**
   * Finds the strength among the card's unlabeled characteristic values —
   * the one value that is exactly a percentage.
   *
   * @param attributes - The card's characteristic values.
   * @returns The ABV, or null when no value is a percentage.
   */
  private abvFromAttributes(attributes: string[]): number | null {
    const raw = attributes.find((value) => ABV_ATTRIBUTE.test(value.trim()));

    return this.normalizer.parseAbvValue(raw);
  }
}
