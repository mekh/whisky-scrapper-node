import { ListingStop } from '~enums';
import { ServerError } from '~errors';

import type { ListingResult, ProductSnapshot } from '~types';

import { BrowserAdapterBase } from '../../browser/browser-adapter.base';
import { sleep } from '../../scrape-timing.util';

import type { RenderDiagnostics } from '../../browser/browser.interfaces';
import type {
  RozetkaPage,
  RozetkaRow,
  RozetkaWalk,
} from './rozetka.interfaces';

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
 * How long to wait before each attempt at one page, the first being immediate.
 * The waits escalate because a page comes back empty when Cloudflare is
 * refusing this browser, and asking again at once is what it is refusing.
 */
const RETRY_BACKOFF_MS = [0, 20_000, 60_000];

/**
 * How many blank pages in a row end the walk. One is a challenge that stuck,
 * which the walk skips and re-reads afterwards; two means the store has
 * stopped answering and the rest of the walk would only spend the budget.
 */
const MAX_BLANK_STREAK = 2;

/**
 * How many blank pages a walk may skip in total. A blank page costs every
 * attempt and every back-off, so without this a listing full of holes would
 * spend the store's whole sync budget and persist nothing.
 */
const MAX_BLANK_PAGES = 4;

const PAGE_PATTERN = /page=(\d+)\//;

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
   * The listing URL of one page. Page 1 is the bare listing URL; a number past
   * the end redirects back to it, which is how the walk knows it has finished.
   *
   * @param page - 1-based page number.
   * @returns The URL to open.
   */
  private static urlOfPage(page: number): string {
    return page === 1 ? LISTING : `${LISTING}page=${page}/`;
  }

  /**
   * The page number a listing URL addresses, so a failure can name it.
   *
   * @param url - A URL built by {@link urlOfPage}.
   * @returns The page number, 1 for the bare listing URL.
   */
  private static pageOfUrl(url: string): number {
    return Number(PAGE_PATTERN.exec(url)?.[1] ?? 1);
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
   * Formats one failed render as the line an operator reads to tell a stuck
   * Cloudflare challenge from a block, a rate limit or a markup change.
   *
   * @param diagnostics - What the render observed.
   * @returns A single-line diagnosis.
   */
  private static diagnose(diagnostics: RenderDiagnostics): string {
    const { challenge: chal } = diagnostics;
    const parts = [
      `status ${diagnostics.status ?? 'none'}`,
      `title ${JSON.stringify(diagnostics.title)}`,
      `challenge ${
        chal.cleared ? 'cleared' : 'TIMED OUT'
      } in ${chal.elapsedMs}ms`,
      `tiles selector ${
        diagnostics.selectorFound === true ? 'found' : 'never'
      }`,
      `url ${diagnostics.finalUrl}`,
      `took ${diagnostics.elapsedMs}ms`,
    ];

    if (diagnostics.cfRay !== null) {
      parts.push(`cf-ray ${diagnostics.cfRay}`);
    }

    if (chal.titles.length > 0) {
      parts.push(`titles seen ${JSON.stringify(chal.titles)}`);
    }

    if (diagnostics.errorResponses.length > 0) {
      parts.push(`failed ${diagnostics.errorResponses.join(' | ')}`);
    }

    parts.push(`body ${JSON.stringify(diagnostics.bodyExcerpt)}`);

    return parts.join('; ');
  }

  /**
   * Walks the category page by page until one yields no tile the walk has not
   * already seen.
   *
   * The two ways this walk can stop mean opposite things. A page number past
   * the end **redirects back to page 1** (verified against the live site on
   * 2026-07-25 and again on 2026-09-05: `page=42/` and `page=60/` answer with
   * the bare listing URL and its 60 tiles), so the real terminator is a page
   * whose tiles the walk had all collected before.
   *
   * A page that rendered no tile at all is never that — it is the Cloudflare
   * challenge winning — but it no longer truncates the walk either: it is
   * recorded, skipped, and re-read once the walk is over, so one stuck page
   * out of forty-one costs its own tiles rather than the whole run. The walk
   * ends on {@link MAX_BLANK_STREAK} blank pages in a row or
   * {@link MAX_BLANK_PAGES} in total — by then the store is refusing the
   * browser and the rest of the walk would only spend the budget.
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
    const walk: RozetkaWalk = {
      snaps: [],
      seen: new Set<string>(),
      stated: null,
      received: 0,
    };
    const blanks: number[] = [];
    let streak = 0;
    let stop = ListingStop.PAGE_CAP;

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const rendered = await this.fetchPage(RozetkaAdapter.urlOfPage(page));

      walk.stated ??= rendered.stated;

      if (rendered.tiles.length === 0) {
        blanks.push(page);
        streak += 1;

        const spent = streak >= MAX_BLANK_STREAK
          || blanks.length >= MAX_BLANK_PAGES;

        if (spent) {
          return this.finish(walk, ListingStop.AMBIGUOUS);
        }

        continue;
      }

      streak = 0;

      const added = this.absorb(walk, rendered.tiles);

      this.emit({
        kind: 'page',
        page,
        added: added ?? 0,
        total: walk.snaps.length,
      });

      if (added === null) {
        stop = ListingStop.EXHAUSTED;
        break;
      }
    }

    const missed = await this.rereadBlankPages(walk, blanks);

    if (missed > 0) {
      return this.finish(walk, ListingStop.AMBIGUOUS);
    }

    return this.finish(walk, stop);
  }

  /**
   * Re-reads the pages that came back blank during the walk, once each.
   *
   * By the time the walk is over the store has had minutes to stop refusing
   * the browser, so a page that was stuck is usually readable now — and a
   * listing made whole this way earns the out-of-stock sweep instead of
   * losing it to one bad page.
   *
   * @param walk - The walk's collected state, extended in place.
   * @param pages - The 1-based page numbers that came back blank.
   * @returns How many of them are still unread.
   */
  private async rereadBlankPages(
    walk: RozetkaWalk,
    pages: number[],
  ): Promise<number> {
    let missed = 0;

    for (const page of pages) {
      await this.restartBrowser();

      const rendered = await this.fetchPage(RozetkaAdapter.urlOfPage(page));

      if (rendered.tiles.length === 0) {
        missed += 1;

        continue;
      }

      const added = this.absorb(walk, rendered.tiles);

      this.emit({ kind: 'page-recovered', page, added: added ?? 0 });
    }

    return missed;
  }

  /**
   * Folds one page's tiles into the walk: counts them as served, keeps the
   * snapshots of the ones it had not seen, and marks every tile seen.
   *
   * @param walk - The walk's collected state, extended in place.
   * @param tiles - The page's tiles, priced or not.
   * @returns How many snapshots the page added, or null when it carried no
   *   tile the walk had not already collected — which is the end of the
   *   listing.
   */
  private absorb(walk: RozetkaWalk, tiles: RozetkaRow[]): number | null {
    walk.received += tiles.length;

    const unseen = tiles.filter(
      (tile) => !walk.seen.has(RozetkaAdapter.skuOf(tile)),
    );
    const fresh = this.freshSnapshots(
      unseen,
      walk.seen,
      (tile) => this.toSnapshot(tile),
    );

    unseen.forEach((tile) => walk.seen.add(RozetkaAdapter.skuOf(tile)));
    walk.snaps.push(...fresh);

    return unseen.length === 0 ? null : fresh.length;
  }

  /**
   * Closes the walk through the base's completeness rules.
   *
   * @param walk - The walk's collected state.
   * @param stop - Why the walk stopped.
   * @returns The listing result.
   */
  private finish(walk: RozetkaWalk, stop: ListingStop): ListingResult {
    return this.listing(walk.snaps, stop, walk.stated, walk.received);
  }

  /**
   * Renders one listing page in a fresh browser context and extracts its
   * tiles and stated count, retrying a page that comes back empty or
   * unrecognized.
   *
   * Every tile must carry either the buy button or an out-of-stock label, and
   * a tile with the buy button must show a price. A tile with neither signal
   * means the markup changed under us; so does one that says "buy" but shows
   * nothing to buy it for — `toSnapshot` can record neither, and a silent drop
   * would let the sweep flag an offer the store calls available as gone the
   * moment the walk completes. So the page is retried and then the whole run
   * fails loudly instead.
   *
   * An empty page is retried on the same schedule, and every failed attempt
   * is reported with what the browser actually had on screen — a stuck
   * challenge, a 403 and a markup change are one symptom here and three
   * different problems.
   *
   * @param url - The listing page URL.
   * @returns The page; its tiles are empty when every attempt came back empty.
   * @throws {ServerError} When a tile carries no usable availability signal.
   */
  private async fetchPage(url: string): Promise<RozetkaPage> {
    let unrecognized = 0;
    let stated: number | null = null;
    let diagnosis = 'no attempt was made';

    for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt += 1) {
      await this.backOff(attempt);

      const { value, diagnostics } = await this.renderEval(
        url,
        PAGE_JS,
        TILE_SELECTOR,
      );
      const page = RozetkaAdapter.asPage(value);

      stated ??= page.stated;
      unrecognized = page.tiles.filter(
        (tile) => RozetkaAdapter.isUnrecognized(tile),
      ).length;

      if (page.tiles.length > 0 && unrecognized === 0) {
        return page;
      }

      diagnosis = RozetkaAdapter.diagnose(diagnostics);
    }

    if (unrecognized > 0) {
      throw new ServerError(
        'Rozetka tiles carry no usable availability signal — markup changed',
        { url, unrecognized },
      );
    }

    this.emit({
      kind: 'page-blank',
      page: RozetkaAdapter.pageOfUrl(url),
      attempts: RETRY_BACKOFF_MS.length,
      diagnosis,
    });

    return { tiles: [], stated };
  }

  /**
   * Waits before a retry, so a store that is refusing the browser is given
   * time to stop rather than asked again immediately. Scaled by the run's
   * delay multiplier, like every other wait this adapter makes.
   *
   * @param attempt - 0-based attempt index; the first one waits not at all.
   * @returns Resolves once the back-off has elapsed.
   */
  private backOff(attempt: number): Promise<void> {
    const delay = (RETRY_BACKOFF_MS[attempt] ?? 0) * this.delayMultiplier;

    return delay <= 0 ? Promise.resolve() : sleep(delay);
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
