import { ListingStop } from '~enums';
import { ServerError } from '~errors';

import type { ListingResult, ProductSnapshot } from '~types';

import { BrowserAdapterBase } from '../../browser/browser-adapter.base';

import type { RozetkaPage, RozetkaRow } from './rozetka.interfaces';

const LISTING = 'https://rozetka.com.ua/ua/viski/c4649130/';

const TILE_SELECTOR = 'rz-catalog-tile';

/**
 * Backstop against a runaway walk: the category has ~41 pages of 60. The old
 * value of 45 left barely six pages of headroom, which stopped being merely
 * tight once the sweep started gating on where a walk ended — a catalogue 15 %
 * larger would have reached the cap, and a cap the walk can reach in normal
 * operation reads as a truncated listing every run.
 */
const MAX_PAGES = 80;

/**
 * One extra attempt per page, in case the Cloudflare challenge flakes once.
 */
const PAGE_ATTEMPTS = 2;

const SKU_PATTERN = /\/p(\d+)\//;

const CATEGORY = 'viski';

/**
 * Scrapes every tile of a page in one pass inside the browser: link, title,
 * both prices and availability.
 *
 * Availability is read from the **buy button**, a positive marker, never from
 * the absence of a phrase. The store has two out-of-stock labels —
 * «Закінчився» for an item that just ran out and «Немає в наявності» for one
 * gone for longer — and the previous rule knew only the second, so every
 * freshly sold-out tile counted as available. The tile carries no status class
 * to key on, so both signals are read separately: the button means available,
 * either label means gone, and a tile with neither is a rendering this
 * extractor does not recognize (handled in `fetchPage`).
 *
 * A tile is kept when it has a link and a title; its price may be null. Until
 * 2026-09 every tile showed a price, sold out or not, so the extractor could
 * drop the price-less ones as noise. Now the sold-out tail renders its price
 * slot empty, and on 2026-09-04 that tail grew to fill the last page of the
 * walk — a page of real tiles that read as an empty page, which the walk
 * treats as the Cloudflare challenge winning and the run as incomplete (see
 * `fetchListing`). So the tile is returned, and it is `toSnapshot` that drops
 * it: it is out of stock and has nothing to record, but it is a tile the store
 * handed over, and it counts as one.
 *
 * The price cleanup drops `\s`, which covers the non-breaking space Rozetka
 * uses as a thousands separator.
 *
 * Exported so the golden test can run this very script in a browser against
 * captured tiles, which is the only way to cover a DOM extractor.
 */
export const EXTRACT_JS = String.raw`
() => {
  const num = s => {
    if (!s) return null;
    const m = s.replace(/\s/g, '').match(/\d+(?:[.,]\d+)?/);
    return m ? parseFloat(m[0].replace(',', '.')) : null;
  };
  const gone = /закінчився|нема\S* в наявн/i;
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
      inStock: !!t.querySelector('button.buy-button'),
      outOfStock: gone.test(t.textContent),
    };
  }).filter(x => x.href && x.title);
}
`;

/**
 * Reads the category size the listing states above the tiles («Знайдено 2410
 * товарів»), or null when the page carries no such figure. The digits are read
 * with every kind of space removed, since the store groups thousands with a
 * non-breaking one.
 *
 * Exported so the golden test can run it against a captured page.
 */
export const COUNT_JS = String.raw`
() => {
  const el = document.querySelector('[data-testid="filters-found-goods"]');
  if (!el) return null;
  const m = (el.textContent || '').replace(/\s/g, '').match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}
`;

/**
 * What one render evaluates: the tiles and the stated count in one round
 * trip, because the context is closed as soon as the page has been read.
 *
 * Exported so the golden test can run the very script production runs.
 */
export const PAGE_JS = '() => ({ '
  + `tiles: (${EXTRACT_JS})(), `
  + `stated: (${COUNT_JS})() `
  + '})';

/**
 * Rozetka (rozetka.com.ua) — behind a Cloudflare managed challenge, so it
 * needs a real browser. The whisky category (`c4649130`) is server-rendered by
 * Angular, so the tiles are in the HTML and no private API is involved.
 *
 * The load-bearing trick: Rozetka blocks the second and later navigations
 * inside one browser context, while a fresh context's first navigation clears
 * the challenge reliably — hence one context per page (which
 * `BrowserAdapterBase.renderEval` gives us). A full pass takes ~12 minutes at
 * the store's politeness delay; that is the accepted cost of reliability.
 */
export class RozetkaAdapter extends BrowserAdapterBase {
  /**
   * Coerces whatever the page evaluation produced into a page, treating any
   * unexpected shape as a page that rendered nothing.
   *
   * @param rendered - The raw evaluation result.
   * @returns The page's tiles and stated count.
   */
  private static asPage(rendered: unknown): RozetkaPage {
    if (rendered === null || typeof rendered !== 'object') {
      return { tiles: [], stated: null };
    }

    const { tiles, stated } = rendered as Partial<RozetkaPage>;

    return {
      tiles: Array.isArray(tiles) ? tiles : [],
      stated: typeof stated === 'number' ? stated : null,
    };
  }

  /**
   * The tile's product URL without its fragment.
   *
   * @param row - The tile's data.
   * @returns The URL, or an empty string when the tile has no link.
   */
  private static urlOf(row: RozetkaRow): string {
    return row.href.split('#')[0];
  }

  /**
   * The tile's store SKU: the product id in its URL, or the whole URL when the
   * link does not carry one. Read for every tile, priced or not, so that a
   * sold-out tile with no price still counts as seen.
   *
   * @param row - The tile's data.
   * @returns The SKU.
   */
  private static skuOf(row: RozetkaRow): string {
    const url = RozetkaAdapter.urlOf(row);

    return SKU_PATTERN.exec(url)?.[1] ?? url;
  }

  /**
   * Whether a tile is a rendering the walk must not act on: it carries neither
   * availability signal, or it carries the buy button but shows no price.
   *
   * @param row - The tile's data.
   * @returns True when the tile cannot be read as either available or gone.
   */
  private static isUnrecognized(row: RozetkaRow): boolean {
    if (!row.inStock && !row.outOfStock) {
      return true;
    }

    return row.inStock && row.price === null;
  }

  /**
   * Walks the category page by page until one yields no tile the walk has not
   * already seen.
   *
   * The two ways this walk can stop mean opposite things. A page number past
   * the end **redirects back to page 1** (verified against the live site on
   * 2026-07-25 and again on 2026-09-05: `page=42/` and `page=60/` answer with
   * the bare listing URL and its 60 tiles), so the real terminator is a page
   * whose tiles the walk had all collected before. A page that rendered no
   * tile at all is never that: `render` swallows the wait-for-selector
   * timeout, so a context still sitting on the Cloudflare challenge reads
   * exactly like an empty catalogue, and the run must not let persist sweep
   * on it.
   *
   * "Seen" is decided per tile, not per snapshot: the sold-out tail shows no
   * price, so its tiles yield no snapshot, but a page of ten such tiles the
   * walk has not met before is still a page of the catalogue — it was reading
   * it as empty that made every run since 2026-09-04 incomplete.
   *
   * The listing also states its own size («Знайдено 2410 товарів»), which the
   * base reconciles against the tiles the store handed over — repeats and
   * price-less tiles included, since both are tiles the store served.
   *
   * @returns The store's whisky listing and whether it is the whole listing.
   */
  public async fetchListing(): Promise<ListingResult> {
    const snaps: ProductSnapshot[] = [];
    const seen = new Set<string>();
    let stated: number | null = null;
    let received = 0;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = page === 1 ? LISTING : `${LISTING}page=${page}/`;
      const rendered = await this.fetchPage(url);

      stated ??= rendered.stated;

      if (rendered.tiles.length === 0) {
        return this.listing(snaps, ListingStop.AMBIGUOUS, stated, received);
      }

      received += rendered.tiles.length;

      const unseen = rendered.tiles.filter(
        (tile) => !seen.has(RozetkaAdapter.skuOf(tile)),
      );
      const fresh = this.freshSnapshots(
        unseen,
        seen,
        (tile) => this.toSnapshot(tile),
      );

      unseen.forEach((tile) => seen.add(RozetkaAdapter.skuOf(tile)));
      snaps.push(...fresh);

      this.emit({
        kind: 'page',
        page,
        added: fresh.length,
        total: snaps.length,
      });

      if (unseen.length === 0) {
        return this.listing(snaps, ListingStop.EXHAUSTED, stated, received);
      }
    }

    return this.listing(snaps, ListingStop.PAGE_CAP, stated, received);
  }

  /**
   * Renders one listing page in a fresh browser context and extracts its
   * tiles and stated count, retrying once when the page comes back empty or
   * unrecognized.
   *
   * Every tile must carry either the buy button or an out-of-stock label, and
   * a tile with the buy button must show a price. A tile with neither signal
   * means the markup changed under us; so does one that says "buy" but shows
   * nothing to buy it for — `toSnapshot` can record neither, and a silent drop
   * would let the sweep flag an offer the store calls available as gone the
   * moment the walk completes. Guessing either way would mass-flag the store's
   * products out of stock (recoverable — the flag flips back on the next good
   * run — but the reports would be wrong meanwhile). So the page is retried
   * and then the whole run fails loudly instead.
   *
   * @param url - The listing page URL.
   * @returns The page; its tiles are empty when both attempts came back empty.
   * @throws {ServerError} When a tile carries no usable availability signal.
   */
  private async fetchPage(url: string): Promise<RozetkaPage> {
    let unrecognized = 0;
    let stated: number | null = null;

    for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt += 1) {
      const rendered = await this.renderEval(url, PAGE_JS, TILE_SELECTOR);
      const page = RozetkaAdapter.asPage(rendered);

      stated ??= page.stated;
      unrecognized = page.tiles.filter(
        (tile) => RozetkaAdapter.isUnrecognized(tile),
      ).length;

      if (page.tiles.length > 0 && unrecognized === 0) {
        return page;
      }
    }

    if (unrecognized > 0) {
      throw new ServerError(
        'Rozetka tiles carry no usable availability signal — markup changed',
        { url, unrecognized },
      );
    }

    return { tiles: [], stated };
  }

  /**
   * Maps one extracted tile to a snapshot.
   *
   * @param row - The tile's data.
   * @returns The snapshot, or null when the tile has no link or shows no
   *   price — by the time a tile gets here a missing price means the sold-out
   *   tail (`fetchPage` refuses an available tile without one), which has
   *   nothing to record.
   */
  private toSnapshot(row: RozetkaRow): ProductSnapshot | null {
    const url = RozetkaAdapter.urlOf(row);

    if (url === '' || row.price === null) {
      return null;
    }

    const discounted = row.old !== null && row.old > row.price;

    return this.makeSnapshot({
      storeSku: RozetkaAdapter.skuOf(row),
      url,
      name: row.title,
      price: row.price,
      oldPrice: discounted ? row.old : null,
      inStock: row.inStock,
      promo: discounted,
      rawAttrs: { category: CATEGORY },
    });
  }
}
