import { load } from 'cheerio';

import type {
  ProductSnapshot,
  ScrapeProgressReporter,
  StoreScrapeSpec,
} from '~types';

import { firstAttr, firstText } from '../../html/html.util';
import { NormalizeService } from '../../normalize/normalize.service';
import { PagedHtmlAdapterBase } from '../paged-html-adapter.base';

import { AlcomagSpecField } from './alcomag.interfaces';

import type { CheerioAPI } from 'cheerio';
import type { HtmlNode } from '../../html/html.interfaces';
import type { ScrapeHttpClient } from '../../http/http-client.interfaces';

const LISTING = 'https://alcomag.ua/ua/krepkie-napitki/viski/';

const CARD_SELECTOR = 'div.catalog_item_wrapp';

const TITLE_SELECTOR = 'div.item-title a';

const ARTICLE_SELECTOR = 'div.article_block';

const STOCK_SELECTOR = 'div.item-stock .value';

const PRICE_SELECTOR = 'div.price[data-value]:not(.discount)';

const OLD_PRICE_SELECTOR = 'div.price.discount[data-value]';

const SPEC_SELECTOR = 'div.properties__item';

const SPEC_TITLE_SELECTOR = 'div.properties__title';

const SPEC_VALUE_SELECTOR = 'div.properties__value';

const DESCRIPTION_SELECTOR = 'div.detail-text-wrap';

const PAGE_PARAM = 'PAGEN_1';

/**
 * Genuine backstop: the catalog is ~31 pages. A page number past the end makes
 * Bitrix serve the first page again, so the walk also stops naturally on the
 * first repeated SKU set.
 */
const MAX_PAGES = 60;

/**
 * Availability is read from a positive marker. Anything else known means out
 * of stock; an unknown label drops the card so a rewording cannot flag the
 * whole store out of stock — the persist sweep guard covers the fallout.
 */
const IN_STOCK_LABEL = 'є в наявності';

const OUT_OF_STOCK_LABELS = new Set([
  'немає в наявності',
  'під замовлення',
  'очікується',
]);

/**
 * Out-of-stock cards carry a `1.00 грн` placeholder instead of a real price,
 * observed across the catalog's trailing pages. An in-stock card at or below
 * it is treated as having no price at all.
 */
const PLACEHOLDER_PRICE = 1;

/**
 * Specification-label prefixes mapped to the snapshot field they fill; the
 * first prefix that matches wins (`об` stands for `` Об`єм ``, whose apostrophe
 * the store types as a backtick).
 */
const SPEC_LABELS: [string, AlcomagSpecField][] = [
  ['країна', AlcomagSpecField.COUNTRY],
  ['міцність', AlcomagSpecField.ABV],
  ['витримка', AlcomagSpecField.AGE],
  ['тип', AlcomagSpecField.WHISKY_TYPE],
  ['об', AlcomagSpecField.VOLUME],
];

/**
 * Reads a numeric attribute value.
 *
 * @param value - The raw attribute value.
 * @returns The number, or null when the attribute is absent or unparseable.
 */
function toFloat(value: string | null): number | null {
  if (value === null || value === '') {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Alcomag (alcomag.ua) — Bitrix (Aspro Max theme), server-rendered. A product
 * card exposes the article number, availability label and machine-readable
 * prices in `data-*` attributes; pagination is `?PAGEN_1=N`. ABV, volume,
 * type, country and age statement live on the product page in its
 * `properties__item` list, so the adapter supports detail enrichment.
 *
 * The page's `Виробник` field is deliberately NOT read as the brand: it names
 * the legal producer, not the consumer brand (`Campari Group` for Old
 * Smuggler, `William Grant & Sons` for Monkey Shoulder — 94 of the 154
 * in-stock items measured at onboarding), and persisting it would mint junk
 * `brand` rows. The brand comes from the pipeline's brand-from-name pass
 * against the catalogue's brand table instead, exactly as it does for rozetka
 * and okwine.
 */
export class AlcomagAdapter extends PagedHtmlAdapterBase {
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
   * Fills ABV / volume / type / country / age from the product page's
   * specification list and stashes the description for the LLM flavor pass.
   * Out-of-stock snapshots are skipped — only their SKU is persisted, so the
   * page fetch would be pure waste.
   *
   * @param snap - The snapshot to enrich; mutated in place, per the adapter
   *   contract.
   * @returns True when the specification list was found.
   */
  public async enrichDetail(snap: ProductSnapshot): Promise<boolean> {
    if (!snap.url || !snap.inStock) {
      return false;
    }

    const response = await this.http.get(snap.url);
    const $ = load(response.text());
    const items = $(SPEC_SELECTOR).toArray();

    if (items.length === 0) {
      return false;
    }

    items.forEach((item) => this.applySpec($, item, snap));
    this.applyDescription($, snap);

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
   * Maps one product card to a snapshot.
   *
   * @param $ - Cheerio root of the listing page.
   * @param card - The card node.
   * @returns The snapshot, or null when the card lacks an article, name or
   *   real price, or carries an unknown availability label.
   */
  protected parseCard($: CheerioAPI, card: HtmlNode): ProductSnapshot | null {
    const name = firstText($, card, TITLE_SELECTOR)?.trim() ?? '';
    const href = firstAttr($, card, TITLE_SELECTOR, 'href') ?? '';
    const sku = firstAttr($, card, ARTICLE_SELECTOR, 'data-value')?.trim()
      ?? '';
    const inStock = this.cardAvailability(
      firstText($, card, STOCK_SELECTOR),
    );
    const price = toFloat(firstAttr($, card, PRICE_SELECTOR, 'data-value'));

    if (
      sku === ''
      || name === ''
      || href === ''
      || inStock === null
      || price === null
    ) {
      return null;
    }

    if (inStock && price <= PLACEHOLDER_PRICE) {
      return null;
    }

    const regular = toFloat(
      firstAttr($, card, OLD_PRICE_SELECTOR, 'data-value'),
    );
    const oldPrice = regular !== null && regular > price ? regular : null;

    return this.makeSnapshot({
      storeSku: sku,
      url: new URL(href, LISTING).toString(),
      name,
      price,
      oldPrice,
      promo: oldPrice !== null,
      inStock,
    });
  }

  /**
   * Reads the availability label into a tri-state flag.
   *
   * @param label - The card's stock label text.
   * @returns True when the positive marker is present, false for a known
   *   out-of-stock label, null for anything else.
   */
  private cardAvailability(label: string | null): boolean | null {
    const lowered = (label ?? '').toLowerCase().trim();

    if (lowered === IN_STOCK_LABEL) {
      return true;
    }

    if (OUT_OF_STOCK_LABELS.has(lowered)) {
      return false;
    }

    return null;
  }

  /**
   * Applies one specification row to the snapshot's still-empty fields.
   *
   * @param $ - Cheerio root of the product page.
   * @param item - The specification row node.
   * @param snap - The snapshot to fill; mutated in place.
   */
  private applySpec(
    $: CheerioAPI,
    item: HtmlNode,
    snap: ProductSnapshot,
  ): void {
    const label = firstText($, item, SPEC_TITLE_SELECTOR)?.toLowerCase()
      .trim() ?? '';
    const value = firstText($, item, SPEC_VALUE_SELECTOR)?.trim() ?? '';

    if (label === '' || value === '') {
      return;
    }

    const field = SPEC_LABELS.find(([prefix]) => label.startsWith(prefix))?.[1];

    if (field === AlcomagSpecField.ABV) {
      snap.abv ??= this.normalizer.parseAbvValue(value);
    } else if (field === AlcomagSpecField.WHISKY_TYPE) {
      snap.whiskyType ??= this.normalizer.extractType(value);
    } else if (field === AlcomagSpecField.VOLUME) {
      snap.volumeMl ??= this.normalizer.parseVolumeValue(value);
    } else if (field === AlcomagSpecField.COUNTRY) {
      snap.country ??= this.normalizer.canonicalCountry(value);
    } else if (field === AlcomagSpecField.AGE) {
      snap.ageYears ??= this.normalizer.extractAgeYears(value);
    }
  }

  /**
   * Stashes the product page's description into `rawAttrs`, where the LLM
   * flavor pass looks for grounding text. Whitespace is collapsed; the prose
   * is never parsed for fields (a description's "N років" is brand history,
   * not maturation).
   *
   * @param $ - Cheerio root of the product page.
   * @param snap - The snapshot to fill; mutated in place.
   */
  private applyDescription($: CheerioAPI, snap: ProductSnapshot): void {
    const description = $(DESCRIPTION_SELECTOR)
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();

    if (description !== '' && snap.rawAttrs.description === undefined) {
      snap.rawAttrs.description = description;
    }
  }
}
