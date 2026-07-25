import { load } from 'cheerio';

import type { ProductSnapshot } from '~types';

import { firstAttr, firstText } from '../html/html.util';
import { PagedHtmlAdapterBase } from './paged-html-adapter.base';

import type { CheerioAPI } from 'cheerio';
import type { HtmlNode } from '../html/html.interfaces';
import type { WooCommercePrices } from './woocommerce-adapter.interfaces';

const TITLE_SELECTOR = '.woocommerce-loop-product__title';

const LINK_SELECTOR = 'a.woocommerce-LoopProduct-link';

const SKU_SELECTOR = 'a[data-product_id]';

/**
 * Both stores serve the specification table twice (mobile + desktop), so the
 * rows are read into a map, which deduplicates them exactly like the Python
 * dict does.
 */
const ATTR_ROW_SELECTOR =
  'table.woocommerce-product-attributes tr, .shop_attributes tr';

const CATEGORY = 'whiskey';

/**
 * Backstop against a runaway walk; both catalogs are ~15 pages.
 */
const MAX_PAGES = 30;

/**
 * Base for the two WooCommerce stores (`winewine`, `wine-point`): identical
 * card markup, identical `/whiskey/page/N/` pagination and an identical
 * detail-page specification table. Only the price markup and the attribute
 * labels differ, and those are what the subclasses provide.
 */
export abstract class WooCommerceAdapterBase extends PagedHtmlAdapterBase {
  public readonly supportsDetail = true;

  protected readonly maxPages = MAX_PAGES;

  /**
   * Root of the whisky listing, with a trailing slash.
   */
  protected abstract readonly listingUrl: string;

  /**
   * Fills the snapshot's still-empty fields from its product page.
   *
   * @param snap - The snapshot to enrich; mutated in place, per the adapter
   *   contract.
   * @returns True when the specification table was found and parsed.
   */
  public async enrichDetail(snap: ProductSnapshot): Promise<boolean> {
    if (!snap.url) {
      return false;
    }

    const response = await this.http.get(snap.url);
    const attributes = this.readAttributes(response.text());

    if (attributes.size === 0) {
      return false;
    }

    this.applyAttributes(snap, attributes);

    return true;
  }

  /**
   * Fetches one listing page.
   *
   * @param page - 1-based page number.
   * @returns The page's HTML.
   */
  protected async fetchPage(page: number): Promise<string> {
    const url = page === 1
      ? this.listingUrl
      : `${this.listingUrl}page/${page}/`;

    const response = await this.http.get(url);

    return response.text();
  }

  /**
   * Maps one listing card to a snapshot.
   *
   * @param $ - Cheerio root of the listing page.
   * @param card - The card node.
   * @returns The snapshot, or null when the card carries no title, link or
   *   price.
   */
  protected parseCard($: CheerioAPI, card: HtmlNode): ProductSnapshot | null {
    const name = firstText($, card, TITLE_SELECTOR);
    const url = firstAttr($, card, LINK_SELECTOR, 'href')
      ?? firstAttr($, card, 'a[href]', 'href');

    if (name === null || url === null) {
      return null;
    }

    const { price, oldPrice } = this.parsePrices($, card);

    if (price === null) {
      return null;
    }

    const classes = $(card).attr('class') ?? '';
    const discounted = oldPrice !== null && oldPrice > price;
    const productId = firstAttr($, card, SKU_SELECTOR, 'data-product_id');

    return this.makeSnapshot({
      storeSku: productId === null || productId === '' ? url : productId,
      url,
      name,
      price,
      oldPrice: discounted ? oldPrice : null,
      inStock: !classes.includes('outofstock'),
      promo: classes.includes('sale') || discounted,
      rawAttrs: { category: CATEGORY },
    });
  }

  /**
   * Reads the current and previous single-bottle price out of one card.
   *
   * @param $ - Cheerio root of the listing page.
   * @param card - The card node.
   * @returns The prices; both may be null.
   */
  protected abstract parsePrices(
    $: CheerioAPI,
    card: HtmlNode,
  ): WooCommercePrices;

  /**
   * Copies the store's specification labels onto the snapshot's empty fields.
   *
   * @param snap - The snapshot to fill; mutated in place, per the adapter
   *   contract.
   * @param attributes - Lower-cased specification label to value.
   */
  protected abstract applyAttributes(
    snap: ProductSnapshot,
    attributes: ReadonlyMap<string, string>,
  ): void;

  /**
   * Reads the product page's specification table into a label/value map, with
   * lower-cased labels.
   *
   * @param html - The product page's HTML.
   * @returns Label to value; empty when the page has no such table.
   */
  private readAttributes(html: string): Map<string, string> {
    const $ = load(html);
    const attributes = new Map<string, string>();

    $(ATTR_ROW_SELECTOR).toArray().forEach((row) => {
      const label = firstText($, row, 'th');
      const value = firstText($, row, 'td');

      if (label !== null && value !== null) {
        attributes.set(label.toLowerCase(), value);
      }
    });

    return attributes;
  }
}
