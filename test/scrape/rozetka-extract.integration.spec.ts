import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright';

import {
  COUNT_JS,
  EXTRACT_JS,
  PAGE_JS,
} from '../../src/scrape/adapters/rozetka/rozetka.adapter';

import type { Browser } from 'playwright';
import type {
  RozetkaPage,
  RozetkaRow,
} from '../../src/scrape/adapters/rozetka/rozetka.interfaces';

/**
 * Golden test for Rozetka's in-page scripts. It runs the very scripts the
 * adapter evaluates, in a real Chromium, against catalog tiles captured from
 * the live store (`fixtures/rozetka-page-*.html`, the `rz-catalog-tile`
 * elements of the page with media markup stripped).
 *
 * A DOM extractor cannot be covered any other way, and the availability rule
 * it encodes is the one that was wrong before: the store marks a sold-out tile
 * either «Закінчився» or «Немає в наявності», so the old rule — the absence of
 * the second phrase — read every freshly sold-out tile as available. Page 7
 * (2026-07-25) is the boundary of the in-stock prefix (both states side by
 * side) and page 8 (2026-07-25) is a fully sold-out page carrying both labels.
 * Page 41 (2026-09-05) is the store's last page as it renders now: ten
 * sold-out tiles whose price slot is empty, plus the «Знайдено N товарів»
 * figure the listing states above them.
 *
 * Needs a local Chromium (`pnpm exec playwright install chromium`), which is
 * why it lives in the integration lane and not in `pnpm test`.
 */
const FIXTURES = join(__dirname, 'fixtures');

/**
 * Loads a captured page into a blank tab and evaluates one of the adapter's
 * in-page scripts against it.
 *
 * @param browser - A launched Chromium instance.
 * @param name - Fixture file name inside the fixtures folder.
 * @param script - Arrow-function source to evaluate, as the adapter would.
 * @returns Whatever the script produced.
 */
async function evaluate(
  browser: Browser,
  name: string,
  script: string,
): Promise<unknown> {
  const html = readFileSync(join(FIXTURES, name), 'utf8');
  const page = await browser.newPage();

  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });

    return await page.evaluate(`(${script})()`);
  } finally {
    await page.close();
  }
}

/**
 * Runs the adapter's tile extractor against a captured page.
 *
 * @param browser - A launched Chromium instance.
 * @param name - Fixture file name inside the fixtures folder.
 * @returns The rows the extractor produced.
 */
async function extract(browser: Browser, name: string): Promise<RozetkaRow[]> {
  return await evaluate(browser, name, EXTRACT_JS) as RozetkaRow[];
}

describe('Rozetka EXTRACT_JS against captured tiles', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser.close();
  });

  it('reads the boundary page: 50 available, 10 sold out', async () => {
    const rows = await extract(browser, 'rozetka-page-7.html');

    expect(rows).toHaveLength(60);
    expect(rows.filter((row) => row.inStock)).toHaveLength(50);
    expect(rows.filter((row) => row.outOfStock)).toHaveLength(10);
    // The old rule saw the whole page as available.
    expect(rows.every((row) => row.price !== null)).toBe(true);
  });

  it('reads a fully sold-out page, both labels included', async () => {
    const rows = await extract(browser, 'rozetka-page-8.html');

    expect(rows).toHaveLength(60);
    expect(rows.filter((row) => row.inStock)).toHaveLength(0);
    expect(rows.filter((row) => row.outOfStock)).toHaveLength(60);
  });

  /**
   * The tail as the store renders it since 2026-09: the tiles are real (link,
   * title, out-of-stock label) but show no price, so they are returned with a
   * null price rather than dropped — a page of them is a page of the
   * catalogue, and the walk must see it as one.
   */
  it('keeps the price-less sold-out tail, with a null price', async () => {
    const rows = await extract(browser, 'rozetka-page-41.html');

    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.price === null)).toBe(true);
    expect(rows.every((row) => row.old === null)).toBe(true);
    expect(rows.filter((row) => row.inStock)).toHaveLength(0);
    expect(rows.filter((row) => row.outOfStock)).toHaveLength(10);
    expect(rows.every((row) => /\/p\d+\//.test(row.href))).toBe(true);
    expect(rows.every((row) => row.title.length > 0)).toBe(true);
  });

  it('gives every tile exactly one availability signal', async () => {
    const pages = await Promise.all([
      extract(browser, 'rozetka-page-7.html'),
      extract(browser, 'rozetka-page-8.html'),
      extract(browser, 'rozetka-page-41.html'),
    ]);
    const rows = pages.flat();

    // The invariant the adapter's page guard relies on.
    expect(rows.filter((row) => row.inStock === row.outOfStock)).toEqual([]);
  });

  it('still reads titles, links and both prices', async () => {
    const rows = await extract(browser, 'rozetka-page-7.html');
    const promo = rows.find((row) => row.old !== null);

    expect(rows.every((row) => /\/p\d+\//.test(row.href))).toBe(true);
    expect(rows.every((row) => row.title.length > 0)).toBe(true);
    expect(promo?.old).toBeGreaterThan(promo?.price ?? 0);
  });
});

describe('Rozetka COUNT_JS against a captured page', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser.close();
  });

  it('reads the category size the listing states', async () => {
    const stated = await evaluate(browser, 'rozetka-page-41.html', COUNT_JS);

    expect(stated).toBe(2410);
  });

  it('states no size for a page without the figure', async () => {
    const stated = await evaluate(browser, 'rozetka-page-7.html', COUNT_JS);

    expect(stated).toBeNull();
  });
});

describe('Rozetka PAGE_JS, the script a render actually evaluates', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser.close();
  });

  it('returns the tiles and the stated size together', async () => {
    const page = await evaluate(
      browser,
      'rozetka-page-41.html',
      PAGE_JS,
    ) as RozetkaPage;

    expect(page.stated).toBe(2410);
    expect(page.tiles).toHaveLength(10);
    expect(page.tiles.every((row) => row.outOfStock)).toBe(true);
  });
});
