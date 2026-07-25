import type { ProductSnapshot } from '~types';

import { BrowserAdapterBase } from '../../browser/browser-adapter.base';

import type { RozetkaRow } from './rozetka.interfaces';

const LISTING = 'https://rozetka.com.ua/ua/viski/c4649130/';

const TILE_SELECTOR = 'rz-catalog-tile';

/**
 * Backstop against a runaway walk: the category has ~38 pages, 60 items each.
 */
const MAX_PAGES = 45;

/**
 * One extra attempt per page, in case the Cloudflare challenge flakes once.
 */
const PAGE_ATTEMPTS = 2;

const SKU_PATTERN = /\/p(\d+)\//;

const CATEGORY = 'viski';

/**
 * Scrapes every tile of a page in one pass inside the browser: link, title,
 * both prices and availability. Ported from the Python adapter, with its two
 * Ukrainian notes translated: a tile without a buy button keeps the "out of
 * stock" status in its text while an available one has no such text, and the
 * tile carries no dedicated status class to key on.
 *
 * The price cleanup drops `\s`, which already covers the non-breaking space
 * Rozetka uses as a thousands separator (the Python source spells that space
 * out separately; in both regex engines it is redundant).
 */
const EXTRACT_JS = String.raw`
() => {
  const num = s => {
    if (!s) return null;
    const m = s.replace(/[\s ]/g, '').match(/\d+(?:[.,]\d+)?/);
    return m ? parseFloat(m[0].replace(',', '.')) : null;
  };
  return [...document.querySelectorAll('rz-catalog-tile')].map(t => {
    const a = t.querySelector('a[href*="/p"]');
    const titleEl = t.querySelector(
      'a.tile-title, .goods-tile__title, [data-testid="goods-tile-title"]'
    ) || a;
    return {
      href: a ? a.href : '',
      title: titleEl ? titleEl.textContent.trim() : '',
      price: num(
        t.querySelector('.price') && t.querySelector('.price').textContent
      ),
      old: num(
        t.querySelector('.old-price')
          && t.querySelector('.old-price').textContent
      ),
      inStock: !/нема\S* в наявн/i.test(t.textContent),
    };
  }).filter(x => x.href && x.title && x.price != null);
}
`;

/**
 * Rozetka (rozetka.com.ua) — behind a Cloudflare managed challenge, so it
 * needs a real browser. The whisky category (`c4649130`) is server-rendered by
 * Angular, so the tiles are in the HTML and no private API is involved.
 *
 * The load-bearing trick: Rozetka blocks the second and later navigations
 * inside one browser context, while a fresh context's first navigation clears
 * the challenge reliably — hence one context per page (which
 * `BrowserAdapterBase.renderEval` gives us). A full pass takes ~20 minutes at
 * the store's politeness delay; that is the accepted cost of reliability.
 */
export class RozetkaAdapter extends BrowserAdapterBase {
  /**
   * Walks the category page by page until one yields no new tile.
   *
   * @returns The store's whisky listing.
   */
  public async fetchListing(): Promise<ProductSnapshot[]> {
    const snaps: ProductSnapshot[] = [];
    const seen = new Set<string>();

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = page === 1 ? LISTING : `${LISTING}page=${page}/`;
      const rows = await this.fetchPage(url);
      const fresh = this.freshSnapshots(
        rows,
        seen,
        (row) => this.toSnapshot(row),
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
   * Renders one listing page in a fresh browser context and extracts its
   * tiles, retrying once when the page comes back empty.
   *
   * @param url - The listing page URL.
   * @returns The page's rows; empty when both attempts failed.
   */
  private async fetchPage(url: string): Promise<RozetkaRow[]> {
    for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt += 1) {
      const result = await this.renderEval(url, EXTRACT_JS, TILE_SELECTOR);
      const rows = Array.isArray(result) ? result as RozetkaRow[] : [];

      if (rows.length > 0) {
        return rows;
      }
    }

    return [];
  }

  /**
   * Maps one extracted tile to a snapshot.
   *
   * @param row - The tile's data.
   * @returns The snapshot, or null when the tile has no link or price.
   */
  private toSnapshot(row: RozetkaRow): ProductSnapshot | null {
    const url = (row.href ?? '').split('#')[0];

    if (url === '' || row.price === null) {
      return null;
    }

    const discounted = row.old !== null && row.old > row.price;
    const sku = SKU_PATTERN.exec(url)?.[1];

    return this.makeSnapshot({
      storeSku: sku ?? url,
      url,
      name: row.title,
      price: row.price,
      oldPrice: discounted ? row.old : null,
      inStock: row.inStock !== false,
      promo: discounted,
      rawAttrs: { category: CATEGORY },
    });
  }
}
