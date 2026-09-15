import { load } from 'cheerio';

import type {
  ProductSnapshot,
  ScrapeProgressReporter,
  StoreScrapeSpec,
} from '~types';

import { firstAttr, firstText, strippedText } from '../../html/html.util';
import { parsePrice } from '../../http/parse-price.util';
import { NormalizeService } from '../../normalize/normalize.service';
import { PagedHtmlAdapterBase } from '../paged-html-adapter.base';

import { VinaMiraAttribute } from './vina-mira.interfaces';

import type { CheerioAPI } from 'cheerio';
import type { HtmlNode } from '../../html/html.interfaces';
import type { ScrapeHttpClient } from '../../http/http-client.interfaces';

const SITE = 'https://vina-mira.com.ua';

const LISTING = `${SITE}/krepkie_napitki/viski/`;

const CARD_SELECTOR = 'div.product-layout div.product-thumb';

const NAME_SELECTOR = 'span[itemprop="name"]';

const URL_SELECTOR = 'link[itemprop="url"]';

/**
 * The price as a bare number; the rendered `.price-new` text carries a
 * currency word and thin spaces.
 */
const PRICE_SELECTOR = 'div.price meta[itemprop="price"]';

/**
 * The pre-discount price, which sits in the image sticker panel rather than
 * beside the current price.
 */
const OLD_PRICE_SELECTOR = 'div.stiker_panel span.price-old';

/**
 * The item count the listing prints under the pager
 * (`Показано з 1 по 100 із 294 (3 сторінок)`).
 */
const PAGER_SELECTOR = 'div.pagpages';

const STATED_COUNT = /Показано\s+з\s+\d+\s+по\s+\d+\s+із\s+(\d+)/u;

/**
 * The OpenCart product id, carried by the card root's own class
 * (`product-thumb product_13731`).
 */
const CARD_ID = /(?:^|\s)product_(\d+)(?:\s|$)/u;

const PAGE_PARAM = 'page';

const LIMIT_PARAM = 'limit';

/**
 * Items per listing page; ~294 bottlings walk in three pages plus the empty
 * fourth that ends them.
 */
const PAGE_SIZE = 100;

/**
 * Backstop against a runaway walk. The page past the end answers 200 with an
 * empty grid, so the no-new-SKU stop is what normally ends it.
 */
const MAX_PAGES = 40;

/**
 * Product-page attributes, matched on the label's prefix because the shop
 * prints them with a trailing colon (`Країна:`).
 */
const ATTRIBUTE_LABELS: [string, VinaMiraAttribute][] = [
  ['країна', VinaMiraAttribute.COUNTRY],
  ['обсяг', VinaMiraAttribute.VOLUME],
  ['об', VinaMiraAttribute.VOLUME],
  ['міцність', VinaMiraAttribute.ABV],
  ['тип', VinaMiraAttribute.WHISKY_TYPE],
];

const DETAIL_ATTRIBUTE_SELECTOR = 'li[itemprop="additionalProperty"]';

const DETAIL_ATTRIBUTE_NAME = '[itemprop="name"]';

const DETAIL_ATTRIBUTE_VALUE = '[itemprop="value"]';

const DETAIL_AVAILABILITY_SELECTOR = 'link[itemprop="availability"]';

/**
 * The description tab, never the page's `meta[itemprop="description"]`, which
 * holds marketing boilerplate naming the shop and the price.
 */
const DETAIL_DESCRIPTION_SELECTOR = 'div#tab-description';

const OUT_OF_STOCK_AVAILABILITY = 'outofstock';

/**
 * Best Wine (vina-mira.com.ua) — OpenCart, server-rendered behind plain nginx,
 * so tier 1 plain fetch. One flat whisky category paged with `?limit=&page=`.
 *
 * Four things the markup gets wrong or leaves out, all documented in
 * `CLAUDE.md` under "Adapters": the `priceCurrency` microdata says `RUB` while
 * the shop prices in hryvnia, the listing states no availability at all, the
 * SKU is the OpenCart product id rather than the article, and the
 * pre-discount price sits in the sticker panel rather than beside the price.
 */
export class VinaMiraAdapter extends PagedHtmlAdapterBase {
  /**
   * Parses a price attribute.
   *
   * @param raw - The attribute value.
   * @returns The price, or null when absent or unparseable.
   */
  private static toFloat(raw: string | null): number | null {
    if (raw === null || raw.trim() === '') {
      return null;
    }

    const value = Number.parseFloat(raw.replace(',', '.'));

    return Number.isFinite(value) && value > 0 ? value : null;
  }

  public readonly supportsDetail = true;

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
   * Fills type, country, volume and ABV from the product page's attribute
   * list, reads its availability statement, and stashes the description for
   * the flavour passes. Only a still-null field is filled.
   *
   * @param snap - The snapshot to enrich; mutated in place, per the adapter
   *   contract.
   * @returns True when the attribute list was found.
   */
  public async enrichDetail(snap: ProductSnapshot): Promise<boolean> {
    if (!snap.url || !snap.inStock) {
      return false;
    }

    const response = await this.http.get(snap.url);
    const $ = load(response.text());
    const items = $(DETAIL_ATTRIBUTE_SELECTOR).toArray();

    this.applyAvailability($, snap);

    if (items.length === 0) {
      return false;
    }

    items.forEach((item) => this.applyAttribute($, item, snap));

    this.applyDescription($, snap);

    return true;
  }

  /**
   * Fetches one listing page, requesting the first without the page
   * parameter as the shop's own pager links it.
   *
   * @param page - 1-based page number.
   * @returns The page's HTML.
   */
  protected async fetchPage(page: number): Promise<string> {
    const params: Record<string, number> = { [LIMIT_PARAM]: PAGE_SIZE };

    if (page > 1) {
      params[PAGE_PARAM] = page;
    }

    const response = await this.http.get(LISTING, { params });

    return response.text();
  }

  /**
   * Maps one product card to a snapshot.
   *
   * @param $ - Cheerio root of the listing page.
   * @param card - The card node.
   * @returns The snapshot, or null when the card lacks an id, name, link or
   *   price; the category page carries one nameless node.
   */
  protected parseCard($: CheerioAPI, card: HtmlNode): ProductSnapshot | null {
    const sku = CARD_ID.exec($(card).attr('class') ?? '')?.[1] ?? '';
    const name = firstText($, card, NAME_SELECTOR)?.trim() ?? '';
    const href = firstAttr($, card, URL_SELECTOR, 'href') ?? '';
    const price = VinaMiraAdapter.toFloat(
      firstAttr($, card, PRICE_SELECTOR, 'content'),
    );

    if (sku === '' || name === '' || href === '' || price === null) {
      return null;
    }

    const regular = parsePrice(firstText($, card, OLD_PRICE_SELECTOR));
    const oldPrice = regular !== null && regular > price ? regular : null;

    return this.makeSnapshot({
      storeSku: sku,
      url: new URL(href, SITE).toString(),
      name,
      price,
      oldPrice,
      promo: oldPrice !== null,
    });
  }

  /**
   * The item count the listing prints under its pager, which the base
   * reconciles against the cards handed over.
   *
   * @param $ - Cheerio root of the listing page.
   * @returns The stated count, or null when the pager states none.
   */
  protected statedItemCount($: CheerioAPI): number | null {
    const stated = STATED_COUNT.exec($(PAGER_SELECTOR).first().text());

    return stated ? Number.parseInt(stated[1], 10) : null;
  }

  /**
   * Applies one product-page attribute to the snapshot.
   *
   * @param $ - Cheerio root of the product page.
   * @param item - The attribute list item.
   * @param snap - The snapshot to fill; mutated in place.
   */
  private applyAttribute(
    $: CheerioAPI,
    item: HtmlNode,
    snap: ProductSnapshot,
  ): void {
    const label = firstText($, item, DETAIL_ATTRIBUTE_NAME)
      ?.toLowerCase()
      .trim() ?? '';
    const value = firstText($, item, DETAIL_ATTRIBUTE_VALUE)?.trim() ?? '';

    if (label === '' || value === '') {
      return;
    }

    const field = ATTRIBUTE_LABELS
      .find(([prefix]) => label.startsWith(prefix))?.[1];

    if (field === VinaMiraAttribute.COUNTRY) {
      snap.country ??= this.normalizer.canonicalCountry(value);
    } else if (field === VinaMiraAttribute.VOLUME) {
      snap.volumeMl ??= this.normalizer.parseVolumeValue(value);
    } else if (field === VinaMiraAttribute.ABV) {
      snap.abv ??= this.normalizer.parseAbvValue(value);
    } else if (field === VinaMiraAttribute.WHISKY_TYPE) {
      snap.whiskyType ??= this.normalizer.extractType(value);
    }
  }

  /**
   * Reads the product page's availability statement, clearing the flag only
   * on an explicit out-of-stock value so an unfamiliar one hides no offer.
   *
   * @param $ - Cheerio root of the product page.
   * @param snap - The snapshot to flag; mutated in place.
   */
  private applyAvailability($: CheerioAPI, snap: ProductSnapshot): void {
    const stated = $(DETAIL_AVAILABILITY_SELECTOR).first().attr('href') ?? '';

    if (stated.toLowerCase().endsWith(OUT_OF_STOCK_AVAILABILITY)) {
      snap.inStock = false;
    }
  }

  /**
   * Stashes the product page's description into `rawAttrs`, the only grounding
   * the flavour passes get. It is never parsed for fields.
   *
   * @param $ - Cheerio root of the product page.
   * @param snap - The snapshot to fill; mutated in place.
   */
  private applyDescription($: CheerioAPI, snap: ProductSnapshot): void {
    const node = $(DETAIL_DESCRIPTION_SELECTOR).first().get(0);

    if (!node) {
      return;
    }

    const description = strippedText($, node).replace(/\s+/g, ' ').trim();

    if (description !== '' && snap.rawAttrs.detailDescription === undefined) {
      snap.rawAttrs.detailDescription = description;
    }
  }
}
