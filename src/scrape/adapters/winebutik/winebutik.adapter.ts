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

import type { CheerioAPI } from 'cheerio';
import type { HtmlNode } from '../../html/html.interfaces';
import type { ScrapeHttpClient } from '../../http/http-client.interfaces';

const SITE = 'https://winebutik.com.ua';

const LISTING = `${SITE}/drinks/category/whiskey`;

const CARD_SELECTOR = 'li.product-item';

const NAME_SELECTOR = 'h2.product-item-name a';

const PRICE_SELECTOR = 'div.product-item-price div.price';

/**
 * The SKU is the Drupal Commerce product id carried by the card's add-to-cart
 * form — present on sold-out cards too, unlike the price.
 */
const SKU_SELECTOR = 'input[name="product_id"]';

const AVAILABILITY_SELECTOR = 'div.field-name-field-available div.field-item';

const VOLUME_SELECTOR = 'div.field-name-field-size div.field-item';

const ABV_SELECTOR = 'div.field-name-field-alcohol div.field-item';

const CARD_DESCRIPTION_SELECTOR = 'div.product-item-des';

/**
 * Product-page fields ("Факти" block). The region field lists links country
 * first (`Шотландія, Спейсайд`), so only the first link is read. The page's
 * `field-link-producer` / `field-producer` are deliberately absent here: they
 * name the legal producer (`Bardinet` for Sir Edwards, `Glen Turner` for Glen
 * Clan), not the consumer brand — the same trap as alcomag's `Виробник` — so
 * the brand is left to the pipeline's brand-from-name pass.
 */
const DETAIL_TYPE_SELECTOR = 'div.field-name-field-link-type div.field-item';

const DETAIL_CLASS_SELECTOR = 'div.field-name-field-link-class div.field-item';

const DETAIL_COUNTRY_SELECTOR = 'div.field-name-field-link-region a';

const DETAIL_BODY_SELECTOR = 'div.field-name-body';

const DETAIL_FACTS_SELECTOR = [
  DETAIL_TYPE_SELECTOR,
  DETAIL_CLASS_SELECTOR,
  DETAIL_COUNTRY_SELECTOR,
].join(', ');

const PAGE_PARAM = 'page';

/**
 * Availability is read from a positive marker. The two labels the sold-out
 * tail uses mean out of stock; an unknown label drops the card, so a
 * rewording can neither flag the store out of stock nor end the walk early.
 */
const IN_STOCK_LABEL = 'є в наявності';

const OUT_OF_STOCK_LABELS = new Set([
  'запитати',
  'у найближчому надходженні',
]);

/**
 * Genuine backstop: the catalog is ~82 pages of 12 including the sold-out
 * tail, and the walk normally ends at the tail's first page (~46). It only
 * ever nears the cap when the whole catalog is purchasable, and the page past
 * the end answers 404 — an end-of-listing signal of its own.
 */
const MAX_PAGES = 120;

/**
 * Винний Бутик (winebutik.com.ua) — Drupal 7 Commerce, fully server-rendered,
 * plain nginx with no bot wall. The listing sorts purchasable items strictly
 * ahead of a sold-out tail that spans dozens of pages, so the walk ends on
 * the first page carrying a known out-of-stock label (`pageEndsListing`)
 * instead of draining the tail — which for this source is the end-of-listing
 * marker, and what earns the sweep. Sold-out cards render no price at all
 * (the store shows no strike-through prices anywhere), so they could not be
 * persisted anyway. The pager is zero-based: the first page is the bare
 * listing URL and `?page=N` is page N+1.
 *
 * The card states name, volume (a bare litre number), strength and a short
 * category-and-origin description; type, country and a longer description
 * live on the product page's "Факти" block, so the adapter supports detail
 * enrichment.
 */
export class WinebutikAdapter extends PagedHtmlAdapterBase {
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
   * Fills type / country / ABV / volume from the product page's "Факти"
   * block and stashes the description for the LLM flavor pass. Out-of-stock
   * snapshots are skipped — only in-stock items are persisted, so the page
   * fetch would be pure waste.
   *
   * @param snap - The snapshot to enrich; mutated in place, per the adapter
   *   contract.
   * @returns True when the facts block was found.
   */
  public async enrichDetail(snap: ProductSnapshot): Promise<boolean> {
    if (!snap.url || !snap.inStock) {
      return false;
    }

    const response = await this.http.get(snap.url);
    const $ = load(response.text());

    if ($(DETAIL_FACTS_SELECTOR).length === 0) {
      return false;
    }

    snap.whiskyType ??= this.detailType($);
    snap.country ??= this.normalizer.canonicalCountry(
      this.fieldText($, DETAIL_COUNTRY_SELECTOR),
    );
    snap.abv ??= this.normalizer.parseAbvValue(
      this.fieldText($, ABV_SELECTOR),
    );
    snap.volumeMl ??= this.normalizer.parseVolumeValue(
      this.fieldText($, VOLUME_SELECTOR),
    );
    this.applyDescription($, snap);

    return true;
  }

  /**
   * Fetches one listing page. The store's pager is zero-based, so the walk's
   * 1-based page number is shifted down by one and the first page is
   * requested without the parameter.
   *
   * @param page - 1-based page number.
   * @returns The page's HTML.
   */
  protected async fetchPage(page: number): Promise<string> {
    const response = await this.http.get(
      LISTING,
      page === 1 ? undefined : { params: { [PAGE_PARAM]: page - 1 } },
    );

    return response.text();
  }

  /**
   * Maps one product card to a snapshot. Only purchasable cards are usable:
   * a sold-out card carries no price, and its role is to end the walk (see
   * {@link pageEndsListing}) rather than to be collected.
   *
   * @param $ - Cheerio root of the listing page.
   * @param card - The card node.
   * @returns The snapshot, or null when the card lacks a SKU, name or price,
   *   or does not carry the positive availability label.
   */
  protected parseCard($: CheerioAPI, card: HtmlNode): ProductSnapshot | null {
    const name = firstText($, card, NAME_SELECTOR)?.trim() ?? '';
    const href = firstAttr($, card, NAME_SELECTOR, 'href') ?? '';
    const sku = firstAttr($, card, SKU_SELECTOR, 'value')?.trim() ?? '';
    const available = this.cardAvailability(
      firstText($, card, AVAILABILITY_SELECTOR),
    );
    const price = parsePrice(firstText($, card, PRICE_SELECTOR));

    if (
      sku === ''
      || name === ''
      || href === ''
      || available !== true
      || price === null
    ) {
      return null;
    }

    const description = this.cardDescription($, card);

    return this.makeSnapshot({
      storeSku: sku,
      url: new URL(href, SITE).toString(),
      name,
      price,
      volumeMl: this.normalizer.parseVolumeValue(
        firstText($, card, VOLUME_SELECTOR),
      ),
      abv: this.normalizer.parseAbvValue(firstText($, card, ABV_SELECTOR)),
      rawAttrs: description === '' ? {} : { description },
    });
  }

  /**
   * Whether the page has reached the sold-out tail. The listing sorts
   * purchasable items strictly ahead of sold-out ones, so the first card
   * carrying a known out-of-stock label means everything the walk is for has
   * been seen. Only the known labels count — an unknown one must not let a
   * relabeled store end the walk with a "complete" verdict it did not earn.
   *
   * @param $ - Cheerio root of the listing page.
   * @returns True when any card carries a known out-of-stock label.
   */
  protected pageEndsListing($: CheerioAPI): boolean {
    const cards = $(CARD_SELECTOR).toArray();

    return cards.some((card) =>
      this.cardAvailability(
        firstText($, card, AVAILABILITY_SELECTOR),
      ) === false
    );
  }

  /**
   * Reads the availability label into a tri-state flag.
   *
   * @param label - The card's availability label text.
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
   * Reads the card's short description (`Купажований шотландський віскі …`) —
   * the haystack the keyword passes read country and flavors from.
   *
   * @param $ - Cheerio root of the listing page.
   * @param card - The card node.
   * @returns The whitespace-collapsed text, empty when the card has none.
   */
  private cardDescription($: CheerioAPI, card: HtmlNode): string {
    return $(card)
      .find(CARD_DESCRIPTION_SELECTOR)
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Reads the whisky type from the product page: the Ukrainian type field
   * first (`Купажований`), falling back to the English classification
   * (`Blended Scotch Whisky`). Each source is canonicalized before the next
   * is consulted, so an unmappable primary value does not eat the fallback.
   *
   * @param $ - Cheerio root of the product page.
   * @returns The canonical type, or null when neither field maps.
   */
  private detailType($: CheerioAPI): string | null {
    const typed = this.normalizer.extractType(
      this.fieldText($, DETAIL_TYPE_SELECTOR) ?? '',
    );

    return typed ?? this.normalizer.extractType(
      this.fieldText($, DETAIL_CLASS_SELECTOR) ?? '',
    );
  }

  /**
   * The stripped text of the first node matching a document-wide selector.
   *
   * @param $ - Cheerio root of the page.
   * @param selector - CSS selector to match.
   * @returns The text, or null when nothing matches.
   */
  private fieldText($: CheerioAPI, selector: string): string | null {
    const node = $(selector).first().get(0);

    return node ? strippedText($, node).trim() : null;
  }

  /**
   * Stashes the product page's description into `rawAttrs`, where the LLM
   * flavor pass looks for grounding text. The prose is never parsed for
   * fields (a description's "N років" is brand history, not maturation).
   *
   * @param $ - Cheerio root of the product page.
   * @param snap - The snapshot to fill; mutated in place.
   */
  private applyDescription($: CheerioAPI, snap: ProductSnapshot): void {
    const description = $(DETAIL_BODY_SELECTOR)
      .first()
      .text()
      .replace(/\s+/g, ' ')
      .trim();

    if (description !== '' && snap.rawAttrs.detailDescription === undefined) {
      snap.rawAttrs.detailDescription = description;
    }
  }
}
