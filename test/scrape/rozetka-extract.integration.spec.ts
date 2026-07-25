import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { EXTRACT_JS } from '../../src/scrape/adapters/rozetka/rozetka.adapter';

import type { Browser } from 'playwright';
import type { RozetkaRow } from '../../src/scrape/adapters/rozetka/rozetka.interfaces';

/**
 * Golden test for Rozetka's in-page DOM extractor. It runs the very script the
 * adapter evaluates, in a real Chromium, against catalog tiles captured from
 * the live store on 2026-07-25 (`fixtures/rozetka-page-*.html`, the
 * `rz-catalog-tile` elements of the page with media markup stripped).
 *
 * A DOM extractor cannot be covered any other way, and the availability rule
 * it encodes is the one that was wrong before: the store marks a sold-out tile
 * either «Закінчився» or «Немає в наявності», so the old rule — the absence of
 * the second phrase — read every freshly sold-out tile as available. Page 7 is
 * the boundary of the in-stock prefix (both states side by side) and page 8 is
 * a fully sold-out page carrying both labels.
 *
 * Needs a local Chromium (`pnpm exec playwright install chromium`), which is
 * why it lives in the integration lane and not in `pnpm test`.
 */
const FIXTURES = join(__dirname, 'fixtures');

/**
 * Loads captured tiles into a blank page and runs the adapter's extractor.
 *
 * @param browser - A launched Chromium instance.
 * @param name - Fixture file name inside the fixtures folder.
 * @returns The rows the extractor produced.
 */
async function extract(browser: Browser, name: string): Promise<RozetkaRow[]> {
  const html = readFileSync(join(FIXTURES, name), 'utf8');
  const page = await browser.newPage();

  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });

    return await page.evaluate(`(${EXTRACT_JS})()`) as RozetkaRow[];
  } finally {
    await page.close();
  }
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

  it('gives every tile exactly one availability signal', async () => {
    const pages = await Promise.all([
      extract(browser, 'rozetka-page-7.html'),
      extract(browser, 'rozetka-page-8.html'),
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
