import 'reflect-metadata';

import { OkwineAdapter } from '../../src/scrape/adapters/okwine';
import { NormalizeService } from '../../src/scrape/normalize/normalize.service';
import { FakeHttpClient } from './fake-http-client';

import type { ProductSnapshot, StoreScrapeSpec } from '~types';
import type {
  OkwineProduct,
} from '../../src/scrape/adapters/okwine/okwine.interfaces';

const SPEC: StoreScrapeSpec = {
  slug: 'okwine',
  name: 'OK Wine',
  baseUrl: 'https://okwine.ua',
  tier: 1,
  needsBrowser: false,
  retailChain: null,
  category: null,
  delayFrom: 0,
  delayTo: 0,
};

/**
 * Builds one API product, mirroring the Python test fixture.
 *
 * @param id - Product id used as the SKU.
 * @param name - Product name.
 * @param over - Price / stock / characteristic overrides.
 * @returns The raw product.
 */
function product(
  id: string,
  name: string,
  over: {
    price?: number;
    old?: number;
    inStock?: boolean;
    volume?: string;
    age?: string;
  } = {},
): OkwineProduct {
  const characteristics = [{
    path: 'obiem',
    values: [{ value: over.volume ?? '700 мл' }],
  }];

  if (over.age) {
    characteristics.push({
      path: 'vytrymka',
      values: [{ value: over.age }],
    });
  }

  return {
    id,
    url: `viski-${id}`,
    name,
    /**
     * `min_price` is not a retail price and must be ignored; it is left out of
     * the typed shape entirely.
     */
    prices: { price: over.price ?? 3315, old_price: over.old ?? 0 },
    inStock: over.inStock ?? true,
    characteristics,
    meta_description: 'опис',
  };
}

/**
 * Wraps products into one filter-API page.
 *
 * @param products - Products of the page.
 * @param maxPage - The page count the API reports.
 * @returns The response body.
 */
function page(products: OkwineProduct[], maxPage = 1): unknown {
  return { data: { productsData: { maxPage, page: 1, data: products } } };
}

/**
 * Builds an adapter over a fake API serving the given pages.
 *
 * @param pages - Products per 1-based page number.
 * @param maxPage - The page count the API reports.
 * @returns The adapter and the fake client it uses.
 */
function makeAdapter(
  pages: Record<number, OkwineProduct[]>,
  maxPage = 1,
): { adapter: OkwineAdapter; http: FakeHttpClient } {
  const http = new FakeHttpClient((_url, options) => ({
    body: page(pages[Number(options?.params?.page)] ?? [], maxPage),
  }));

  const adapter = new OkwineAdapter(SPEC, 1, http, new NormalizeService());

  return { adapter, http };
}

/**
 * Collects a single-product listing and returns that snapshot.
 *
 * @param raw - The raw product to serve on page 1.
 * @returns The mapped snapshot, or undefined when the item was dropped.
 */
async function snapshotOf(
  raw: OkwineProduct,
): Promise<ProductSnapshot | undefined> {
  const { adapter } = makeAdapter({ 1: [raw] });
  const snaps = await adapter.fetchListing();

  return snaps[0];
}

describe('OkwineAdapter', () => {
  it('maps the core fields and the characteristics', async () => {
    const snap = await snapshotOf(
      product('abc', 'Віскі X, 46%, 0.7л', { age: '21 рік' }),
    );

    expect(snap).toBeDefined();
    expect(snap?.price).toBe(3315);
    expect(snap?.storeSlug).toBe('okwine');
    expect(snap?.storeSku).toBe('abc');
    expect(snap?.url).toBe('https://okwine.ua/ua/product/viski-abc');
    expect(snap?.volumeMl).toBe(700);
    expect(snap?.ageYears).toBe(21);
    expect(snap?.oldPrice).toBeNull();
    expect(snap?.promo).toBe(false);
  });

  it('flags a promo when the old price is higher', async () => {
    const snap = await snapshotOf(
      product('p', 'Віскі Y', { price: 2000, old: 2500 }),
    );

    expect(snap?.oldPrice).toBe(2500);
    expect(snap?.promo).toBe(true);
  });

  it('ignores an old price below the current one', async () => {
    const snap = await snapshotOf(
      product('p', 'Віскі Z', { price: 2500, old: 2000 }),
    );

    expect(snap?.oldPrice).toBeNull();
    expect(snap?.promo).toBe(false);
  });

  it('skips an item without a price', async () => {
    const priceless = product('1', 'Віскі без ціни');

    priceless.prices = { price: 0, old_price: 0 };

    const snap = await snapshotOf(priceless);

    expect(snap).toBeUndefined();
  });

  it('carries the stock flag through', async () => {
    const out = await snapshotOf(product('a', 'A', { inStock: false }));
    const inStock = await snapshotOf(product('b', 'B', { inStock: true }));

    expect(out?.inStock).toBe(false);
    expect(inStock?.inStock).toBe(true);
  });

  it('paginates via maxPage and deduplicates', async () => {
    const { adapter, http } = makeAdapter(
      {
        1: [product('a', 'A'), product('b', 'B')],
        2: [product('b', 'B'), product('c', 'C')],
      },
      2,
    );

    const snaps = await adapter.fetchListing();

    expect(snaps.map((snap) => snap.storeSku).sort()).toEqual(['a', 'b', 'c']);
    expect(http.pages()).toEqual([1, 2]);
  });

  it('keeps the pages it already has when a later page fails', async () => {
    const http = new FakeHttpClient((_url, options) => {
      if (Number(options?.params?.page) === 1) {
        return { body: page([product('a', 'A')], 3) };
      }

      throw new Error('502');
    });
    const adapter = new OkwineAdapter(SPEC, 1, http, new NormalizeService());

    const snaps = await adapter.fetchListing();

    expect(snaps.map((snap) => snap.storeSku)).toEqual(['a']);
  });

  it('fails when the very first page fails', async () => {
    const http = new FakeHttpClient(() => {
      throw new Error('502');
    });
    const adapter = new OkwineAdapter(SPEC, 1, http, new NormalizeService());

    await expect(adapter.fetchListing()).rejects.toThrow('502');
  });
});
