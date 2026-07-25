import 'reflect-metadata';

import { RozetkaAdapter } from '../../src/scrape/adapters/rozetka';

import type { StoreScrapeSpec } from '~types';
import type { RozetkaRow } from '../../src/scrape/adapters/rozetka/rozetka.interfaces';

const SPEC: StoreScrapeSpec = {
  slug: 'rozetka',
  name: 'Rozetka',
  baseUrl: 'https://rozetka.com.ua',
  tier: 3,
  needsBrowser: true,
  retailChain: null,
  category: null,
  delayFrom: 0,
  delayTo: 0,
};

const LISTING = 'https://rozetka.com.ua/ua/viski/c4649130/';

/**
 * A `RozetkaAdapter` whose browser is replaced by canned extractor results, so
 * the pagination, retry, deduplication and mapping logic is tested without
 * launching Chromium (the browser itself is covered by the live parity run).
 */
class FakeRozetkaAdapter extends RozetkaAdapter {
  public readonly urls: string[] = [];

  private readonly pages: RozetkaRow[][];

  public constructor(pages: RozetkaRow[][]) {
    super(SPEC, 1);

    this.pages = pages;
  }

  /**
   * Serves the next canned page instead of rendering one.
   *
   * @param url - The URL that would have been opened.
   * @returns The canned rows for this call.
   */
  protected renderEval(url: string): Promise<unknown> {
    this.urls.push(url);

    return Promise.resolve(this.pages[this.urls.length - 1] ?? []);
  }
}

/**
 * Builds one extracted tile.
 *
 * @param id - Product id, which appears in the URL as `/p<id>/`.
 * @param over - Field overrides.
 * @returns The tile row.
 */
function row(id: string, over: Partial<RozetkaRow> = {}): RozetkaRow {
  return {
    href: `https://rozetka.com.ua/ua/viski-jameson/p${id}/`,
    title: 'Віскі Jameson 0.7 л',
    price: 899,
    old: null,
    inStock: true,
    ...over,
  };
}

describe('RozetkaAdapter.fetchListing', () => {
  it(
    'takes the SKU out of the product URL and drops the fragment',
    async () => {
      const adapter = new FakeRozetkaAdapter([[
        row('123', { href: 'https://rozetka.com.ua/ua/x/p123/#comments' }),
      ]]);

      const [snap] = await adapter.fetchListing();

      expect(snap.storeSku).toBe('123');
      expect(snap.url).toBe('https://rozetka.com.ua/ua/x/p123/');
      expect(snap.name).toBe('Віскі Jameson 0.7 л');
      expect(snap.price).toBe(899);
      expect(snap.promo).toBe(false);
      expect(snap.inStock).toBe(true);
    },
  );

  it('reads a promotion and an out-of-stock tile', async () => {
    const adapter = new FakeRozetkaAdapter([[
      row('1', { price: 799, old: 999 }),
      row('2', { inStock: false }),
      row('3', { price: 500, old: 400 }),
    ]]);

    const snaps = await adapter.fetchListing();

    expect(snaps[0].oldPrice).toBe(999);
    expect(snaps[0].promo).toBe(true);
    expect(snaps[1].inStock).toBe(false);
    // An "old" price below the current one is not a promotion.
    expect(snaps[2].oldPrice).toBeNull();
    expect(snaps[2].promo).toBe(false);
  });

  it('drops tiles without a link or a price', async () => {
    const adapter = new FakeRozetkaAdapter([[
      row('1', { href: '' }),
      row('2', { price: null }),
    ]]);

    await expect(adapter.fetchListing()).resolves.toEqual([]);
  });

  it('paginates with page=N and deduplicates promoted tiles', async () => {
    const adapter = new FakeRozetkaAdapter([
      [row('1'), row('2')],
      [row('2'), row('3')],
      [],
    ]);

    const snaps = await adapter.fetchListing();

    expect(snaps.map((snap) => snap.storeSku)).toEqual(['1', '2', '3']);
    expect(adapter.urls).toEqual([
      LISTING,
      `${LISTING}page=2/`,
      `${LISTING}page=3/`,
      `${LISTING}page=3/`,
    ]);
  });

  it('retries an empty page once before ending the walk', async () => {
    const adapter = new FakeRozetkaAdapter([
      [row('1')],
      [],
      [row('2')],
    ]);

    const snaps = await adapter.fetchListing();

    // Page 2 came back empty, the retry succeeded, page 3 ended the walk.
    expect(snaps.map((snap) => snap.storeSku)).toEqual(['1', '2']);
    expect(adapter.urls).toEqual([
      LISTING,
      `${LISTING}page=2/`,
      `${LISTING}page=2/`,
      `${LISTING}page=3/`,
      `${LISTING}page=3/`,
    ]);
  });
});
