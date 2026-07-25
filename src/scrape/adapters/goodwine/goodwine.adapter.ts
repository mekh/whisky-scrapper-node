import { load } from 'cheerio';

import type {
  ProductSnapshot,
  ScrapeProgressReporter,
  StoreScrapeSpec,
} from '~types';

import { strippedText } from '../../html/html.util';
import { NormalizeService } from '../../normalize/normalize.service';
import { PagedHtmlAdapterBase } from '../paged-html-adapter.base';

import { GoodwineSpecField } from './goodwine.interfaces';

import type { CheerioAPI } from 'cheerio';
import type { HtmlNode } from '../../html/html.interfaces';
import type { ScrapeHttpClient } from '../../http/http-client.interfaces';

const LISTING = 'https://goodwine.com.ua/ua/napoi/viski/';

const CARD_SELECTOR = 'form[data-product-id]';

const SPEC_SELECTOR = 'li.product-attr-item';

const PAGE_PARAM = 'p';

const CATEGORY = 'viski';

/**
 * The category rubric that makes `data-category4` a country name.
 */
const COUNTRY_RUBRIC = 'Країни';

/**
 * KNOWN DEFECT, kept at the legacy scraper's value on purpose: the catalog is
 * ~32 pages, so this is not a backstop but a truncation — the walk ends on the
 * limit instead of at the end of the catalog and ~48 SKUs are never seen.
 * Raising it here alone would make this engine disagree with the Python one and
 * fail the parity gate, so the fix waits until the migration is complete. See
 * `FOLLOWUPS.md`, item 1.
 */
const MAX_PAGES = 30;

/**
 * Specification-label prefixes mapped to the snapshot field they fill, in the
 * order the Python adapter tries them — the first prefix that matches wins, so
 * the order is load-bearing (`об` stands for `Об'єм`).
 */
const SPEC_LABELS: [string, GoodwineSpecField][] = [
  ['країна', GoodwineSpecField.COUNTRY],
  ['ємність', GoodwineSpecField.VOLUME],
  ['об', GoodwineSpecField.VOLUME],
  ['міцність', GoodwineSpecField.ABV],
  ['тип віскі', GoodwineSpecField.WHISKY_TYPE],
  ['торгова марка', GoodwineSpecField.BRAND],
];

/**
 * Reads a numeric `data-*` attribute.
 *
 * @param value - The raw attribute value.
 * @returns The number, or null when the attribute is absent or unparseable.
 */
function toFloat(value: string | undefined): number | null {
  if (value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Goodwine (goodwine.com.ua) — Magento, server-rendered. A product card is a
 * `<form>` carrying the whole item in `data-*` attributes (name, sku, prices,
 * brand, category path), which is far more reliable than parsing the rendered
 * text. Pagination is `?p=N`. ABV, type and volume are only on the product
 * page, in its `li.product-attr-item` specification list.
 */
export class GoodwineAdapter extends PagedHtmlAdapterBase {
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
   * Fills ABV / type / volume / country / brand from the product page's
   * specification list, whose items read `Label:Value`.
   *
   * @param snap - The snapshot to enrich; mutated in place, per the adapter
   *   contract.
   * @returns True when the specification list was found.
   */
  public async enrichDetail(snap: ProductSnapshot): Promise<boolean> {
    if (!snap.url) {
      return false;
    }

    const response = await this.http.get(snap.url);
    const $ = load(response.text());
    const items = $(SPEC_SELECTOR).toArray();

    if (items.length === 0) {
      return false;
    }

    items.forEach((item) => this.applySpec(snap, strippedText($, item)));

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
   * Maps one product card to a snapshot, reading everything from its `data-*`
   * attributes.
   *
   * @param $ - Cheerio root of the listing page.
   * @param card - The card node.
   * @returns The snapshot, or null when the card lacks a SKU, name or price.
   */
  protected parseCard($: CheerioAPI, card: HtmlNode): ProductSnapshot | null {
    const form = $(card);
    const sku = form.attr('data-sku') ?? form.attr('data-product-id') ?? '';
    const name = form.attr('data-name') ?? '';
    const regular = toFloat(form.attr('data-price'));
    const final = toFloat(form.attr('data-finalprice'));
    const price = final === null || final === 0 ? regular : final;

    if (sku === '' || name === '' || price === null) {
      return null;
    }

    const oldPrice = regular !== null && regular > price ? regular : null;
    const country = this.cardCountry(
      form.attr('data-category3'),
      form.attr('data-category4'),
    );

    return this.makeSnapshot({
      storeSku: sku,
      url: this.productUrl($, card),
      name,
      brand: form.attr('data-brand') ?? null,
      price,
      oldPrice,
      promo: oldPrice !== null,
      country: this.normalizer.canonicalCountry(country),
      rawAttrs: { category: CATEGORY },
    });
  }

  /**
   * The product page URL of a card: the first absolute link that is not a
   * cart/checkout action. The markup also carries a copy of the link with a
   * leading space, which is skipped exactly as the Python adapter skips it.
   *
   * @param $ - Cheerio root of the listing page.
   * @param card - The card node.
   * @returns The URL, or an empty string when the card has no usable link.
   */
  private productUrl($: CheerioAPI, card: HtmlNode): string {
    const href = $(card)
      .find('a[href]')
      .toArray()
      .map((link) => $(link).attr('href') ?? '')
      .find((candidate) =>
        !candidate.includes('/checkout/')
        && !candidate.includes('/cart/')
        && candidate.startsWith('http')
      );

    return href ?? '';
  }

  /**
   * The country of a card, which the category path exposes only when the third
   * level is the country rubric.
   *
   * @param rubric - `data-category3`.
   * @param value - `data-category4`.
   * @returns The country name, or null.
   */
  private cardCountry(
    rubric: string | undefined,
    value: string | undefined,
  ): string | null {
    if ((rubric ?? '').trim() !== COUNTRY_RUBRIC) {
      return null;
    }

    const country = (value ?? '').trim();

    return country === '' ? null : country;
  }

  /**
   * Applies one `Label:Value` specification line to the snapshot's still-empty
   * fields.
   *
   * @param snap - The snapshot to fill; mutated in place.
   * @param line - The specification item's text.
   */
  private applySpec(snap: ProductSnapshot, line: string): void {
    const separator = line.indexOf(':');

    if (separator === -1) {
      return;
    }

    const label = line.slice(0, separator).toLowerCase().trim();
    const value = line.slice(separator + 1).trim();
    const field = SPEC_LABELS.find(([prefix]) => label.startsWith(prefix))?.[1];

    if (field === GoodwineSpecField.ABV) {
      snap.abv ??= this.normalizer.parseAbvValue(value);
    } else if (field === GoodwineSpecField.WHISKY_TYPE) {
      snap.whiskyType ??= this.normalizer.extractType(value);
    } else if (field === GoodwineSpecField.VOLUME) {
      snap.volumeMl ??= this.normalizer.parseVolumeValue(value);
    } else if (field === GoodwineSpecField.COUNTRY) {
      snap.country ??= this.normalizer.canonicalCountry(value);
    } else if (field === GoodwineSpecField.BRAND && !snap.brand) {
      snap.brand = value === '' ? null : value;
    }
  }
}
