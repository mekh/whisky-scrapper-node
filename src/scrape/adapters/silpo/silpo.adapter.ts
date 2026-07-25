import { load } from 'cheerio';

import type { ProductSnapshot } from '~types';

import { BrowserAdapterBase } from '../../browser/browser-adapter.base';
import { firstAttr, firstText } from '../../html/html.util';
import { parsePrice } from '../../http/parse-price.util';

import type { CheerioAPI } from 'cheerio';
import type { HtmlNode } from '../../html/html.interfaces';

const SITE = 'https://silpo.ua';

const LISTING = `${SITE}/category/alkohol-4137/viski-4321`;

const CARD_SELECTOR = '.product-card, .products-list__item';

const NAME_SELECTOR = '.product-card__title, .product-card__name';

const PRICE_SELECTOR =
  '.product-card-price__displayPrice, .ft-new-price, .product-price';

const OLD_PRICE_SELECTOR = '.product-card-price__oldPrice, .ft-old-price, del';

const CATEGORY = 'viski';

const MAX_PAGES = 20;

/**
 * Silpo (silpo.ua) — the most aggressively protected store in the catalog, and
 * the only one still disabled: `store.active` is false and its
 * `store_config.engine` stays `python`, so `AdapterRegistryService` does not
 * register this adapter. It is ported for structural parity with the legacy
 * scraper, and its selectors carry the same "best-effort, may need refinement"
 * caveat they do there — they have never been validated against a live page.
 *
 * One deliberate difference from the Python adapter: it walks the whole
 * catalog in a single browser context, while this one renders each page in a
 * fresh one (the `rozetka` pattern), which is strictly safer against
 * Cloudflare. Nothing depends on the old behavior while the store is off.
 */
export class SilpoAdapter extends BrowserAdapterBase {
  /**
   * Walks the whisky category until a page yields no new item.
   *
   * @returns The store's whisky listing.
   */
  public async fetchListing(): Promise<ProductSnapshot[]> {
    const snaps: ProductSnapshot[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = page === 1 ? LISTING : `${LISTING}?page=${page}`;
      const html = await this.renderHtml(url, CARD_SELECTOR);
      const $ = load(html);
      const fresh = this.freshSnapshots(
        $(CARD_SELECTOR).toArray(),
        seen,
        (card) => this.toSnapshot($, card),
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
    }

    return snaps;
  }

  /**
   * Maps one product card to a snapshot. The store exposes no SKU, so the
   * product URL doubles as the identifier.
   *
   * @param $ - Cheerio root of the listing page.
   * @param card - The card node.
   * @returns The snapshot, or null when the card lacks a link, name or price.
   */
  private toSnapshot($: CheerioAPI, card: HtmlNode): ProductSnapshot | null {
    const href = firstAttr($, card, 'a[href]', 'href');
    const name = firstText($, card, NAME_SELECTOR);
    const price = parsePrice(firstText($, card, PRICE_SELECTOR));

    if (href === null || name === null || price === null) {
      return null;
    }

    const url = href.startsWith('http') ? href : `${SITE}${href}`;
    const oldPrice = parsePrice(firstText($, card, OLD_PRICE_SELECTOR));
    const discounted = oldPrice !== null && oldPrice > price;

    return this.makeSnapshot({
      storeSku: url,
      url,
      name,
      price,
      oldPrice: discounted ? oldPrice : null,
      promo: discounted,
      rawAttrs: { category: CATEGORY },
    });
  }
}
