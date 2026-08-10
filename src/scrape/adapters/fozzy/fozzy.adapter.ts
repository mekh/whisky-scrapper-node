import { load } from 'cheerio';

import type {
  ProductSnapshot,
  ScrapeProgressReporter,
  StoreScrapeSpec,
} from '~types';

import { firstAttr, firstText } from '../../html/html.util';
import { NormalizeService } from '../../normalize/normalize.service';
import { PagedHtmlAdapterBase } from '../paged-html-adapter.base';

import { FozzySpecField } from './fozzy.interfaces';

import type { CheerioAPI } from 'cheerio';
import type { HtmlNode } from '../../html/html.interfaces';
import type { ScrapeHttpClient } from '../../http/http-client.interfaces';

const LISTING = 'https://fozzyshop.ua/4147-viski';

const CARD_SELECTOR = 'div.product-mini-card[data-product-id]';

const PRICES_SELECTOR = '.product_mini_prices_block';

const URL_SELECTOR = '.product_mini_name a[href]';

const UNIT_SELECTOR = '.product_mini_unit';

const SPEC_ITEM_SELECTOR = '.product_characteristics_item';

const SPEC_NAME_SELECTOR = '.product_characteristics_name';

const SPEC_VALUE_SELECTOR = '.product_characteristics_val';

const PAGE_PARAM = 'page';

const CATEGORY = 'viski';

/**
 * The `data-price-type` value marking a discounted card, in which case
 * `data-secondary-price` is the pre-promotion price. The other observed types
 * (`wholesaleMinQuantity`, `default`) reuse the same attribute for the bulk
 * price of a case, which must never be read as a strike-through price.
 */
const PROMOTION_PRICE_TYPE = 'promotion';

/**
 * Backstop against a runaway walk; the category is ~13 pages today.
 */
const MAX_PAGES = 40;

/**
 * Characteristics-label prefixes mapped to the snapshot field they fill; the
 * first prefix that matches wins. `Вид` (the category, always "Віскі") and
 * `Регіон` are deliberately absent — the type lives under `Тип` and a region
 * is not a country.
 */
const SPEC_LABELS: [string, FozzySpecField][] = [
  ['країна', FozzySpecField.COUNTRY],
  ['бренд', FozzySpecField.BRAND],
  ['міцність', FozzySpecField.ABV],
  ['термін витримки', FozzySpecField.AGE],
  ['тип', FozzySpecField.WHISKY_TYPE],
];

/**
 * Reads a numeric attribute value.
 *
 * @param value - The raw attribute value.
 * @returns The number, or null when the attribute is absent or unparseable.
 */
function toFloat(value: string | null | undefined): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Fozzy Shop (fozzyshop.ua) — server-rendered listing behind Cloudflare that
 * answers plain requests. A product card carries the item in `data-*`
 * attributes (id, name, prices, price type); the bottle volume is only in the
 * card's rendered unit label. Pagination is `?page=N`; a page past the end is
 * a 404, which ends the walk. Only available items are listed, so everything
 * scraped is in stock. ABV, country, brand, age and type live on the product
 * page, in its characteristics list.
 */
export class FozzyAdapter extends PagedHtmlAdapterBase {
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
   * Fills country / brand / ABV / age / type from the product page's
   * characteristics list.
   *
   * @param snap - The snapshot to enrich; mutated in place, per the adapter
   *   contract.
   * @returns True when the characteristics list was found.
   */
  public async enrichDetail(snap: ProductSnapshot): Promise<boolean> {
    if (!snap.url) {
      return false;
    }

    const response = await this.http.get(snap.url);
    const $ = load(response.text());
    const items = $(SPEC_ITEM_SELECTOR).toArray();

    if (items.length === 0) {
      return false;
    }

    items.forEach((item) => {
      this.applySpec(
        snap,
        firstText($, item, SPEC_NAME_SELECTOR),
        firstText($, item, SPEC_VALUE_SELECTOR),
      );
    });

    return true;
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
   * Maps one product card to a snapshot, reading the item from its `data-*`
   * attributes and the bottle volume from the rendered unit label.
   *
   * @param $ - Cheerio root of the listing page.
   * @param card - The card node.
   * @returns The snapshot, or null when the card lacks a SKU, name or price.
   */
  protected parseCard($: CheerioAPI, card: HtmlNode): ProductSnapshot | null {
    const node = $(card);
    const sku = node.attr('data-product-id') ?? '';
    const name = node.attr('data-product-name') ?? '';
    const priceType = firstAttr($, card, PRICES_SELECTOR, 'data-price-type')
      ?? node.attr('data-price-type');
    const price = toFloat(
      firstAttr($, card, PRICES_SELECTOR, 'data-main-price')
        ?? node.attr('data-price'),
    );

    if (sku === '' || name === '' || price === null) {
      return null;
    }

    const oldPrice = this.promoOldPrice($, card, priceType, price);

    return this.makeSnapshot({
      storeSku: sku,
      url: firstAttr($, card, URL_SELECTOR, 'href') ?? '',
      name,
      price,
      oldPrice,
      promo: priceType === PROMOTION_PRICE_TYPE,
      volumeMl: this.normalizer.parseVolumeValue(
        firstText($, card, UNIT_SELECTOR),
      ),
      rawAttrs: { category: CATEGORY },
    });
  }

  /**
   * The pre-promotion price of a discounted card. Read only when the card is
   * a promotion — every other price type reuses `data-secondary-price` for
   * the bulk price of a case, which is lower than the shelf price and must
   * not surface as a strike-through.
   *
   * @param $ - Cheerio root of the listing page.
   * @param card - The card node.
   * @param priceType - The card's `data-price-type`.
   * @param price - The current price.
   * @returns The old price, or null.
   */
  private promoOldPrice(
    $: CheerioAPI,
    card: HtmlNode,
    priceType: string | undefined,
    price: number,
  ): number | null {
    if (priceType !== PROMOTION_PRICE_TYPE) {
      return null;
    }

    const secondary = toFloat(
      firstAttr($, card, PRICES_SELECTOR, 'data-secondary-price'),
    );

    return secondary !== null && secondary > price ? secondary : null;
  }

  /**
   * Applies one characteristics line to the snapshot's still-empty fields.
   *
   * @param snap - The snapshot to fill; mutated in place.
   * @param label - The characteristic's label.
   * @param value - The characteristic's value.
   */
  private applySpec(
    snap: ProductSnapshot,
    label: string | null,
    value: string | null,
  ): void {
    if (label === null || value === null) {
      return;
    }

    const lowered = label.toLowerCase().trim();
    const field = SPEC_LABELS.find(
      ([prefix]) => lowered.startsWith(prefix),
    )?.[1];

    if (field === FozzySpecField.COUNTRY) {
      snap.country ??= this.normalizer.canonicalCountry(value);
    } else if (field === FozzySpecField.BRAND && !snap.brand) {
      snap.brand = value.trim() === '' ? null : value.trim();
    } else if (field === FozzySpecField.ABV) {
      snap.abv ??= this.normalizer.parseAbvValue(value);
    } else if (field === FozzySpecField.AGE) {
      snap.ageYears ??= this.normalizer.parseAgeValue(value);
    } else if (field === FozzySpecField.WHISKY_TYPE) {
      snap.whiskyType ??= this.normalizer.extractType(value);
    }
  }
}
