import 'reflect-metadata';

import { SilpoAdapter } from '../../src/scrape/adapters/silpo';
import { NormalizeService } from '../../src/scrape/normalize/normalize.service';
import { FakeHttpClient } from './fake-http-client';

import type { ProductSnapshot, StoreScrapeSpec } from '~types';
import type {
  SilpoProduct,
} from '../../src/scrape/adapters/silpo/silpo.interfaces';

const SPEC: StoreScrapeSpec = {
  slug: 'silpo',
  name: 'Сільпо',
  baseUrl: 'https://silpo.ua',
  tier: 1,
  needsBrowser: false,
  retailChain: null,
  category: null,
  delayFrom: 0,
  delayTo: 0,
};

const PAGE_SIZE = 100;

/**
 * Builds one API product, mirroring a captured catalog response.
 *
 * @param id - Numeric product id used as the SKU.
 * @param title - Product name.
 * @param over - Price / stock / ratio overrides.
 * @returns The raw product.
 */
function product(
  id: number,
  title: string,
  over: {
    price?: number;
    old?: number | null;
    stock?: number | null;
    ratio?: string | null;
    brand?: string | null;
  } = {},
): SilpoProduct {
  return {
    title,
    price: over.price ?? 649,
    oldPrice: 'old' in over ? over.old : null,
    slug: `viski-${id}`,
    externalProductId: id,
    stock: 'stock' in over ? over.stock : 3,
    displayRatio: 'ratio' in over ? over.ratio : '0,7л',
    brandTitle: 'brand' in over ? over.brand : 'Jameson',
  };
}

/**
 * Builds an adapter over a fake API serving the given pages.
 *
 * @param pages - Products per 1-based page number.
 * @param total - The item count the API reports.
 * @returns The adapter and the fake client it uses.
 */
function makeAdapter(
  pages: Record<number, SilpoProduct[]>,
  total: number,
): { adapter: SilpoAdapter; http: FakeHttpClient } {
  const http = new FakeHttpClient((_url, options) => {
    const page = Number(options?.params?.offset) / PAGE_SIZE + 1;

    return { body: { total, items: pages[page] ?? [] } };
  });

  const adapter = new SilpoAdapter(SPEC, 1, http, new NormalizeService());

  return { adapter, http };
}

/**
 * Collects a single-product listing and returns that snapshot.
 *
 * @param raw - The raw product to serve on page 1.
 * @returns The mapped snapshot, or undefined when the item was dropped.
 */
async function snapshotOf(
  raw: SilpoProduct,
): Promise<ProductSnapshot | undefined> {
  const { adapter } = makeAdapter({ 1: [raw] }, 1);
  const snaps = await adapter.fetchListing();

  return snaps[0];
}

describe('SilpoAdapter', () => {
  it('maps the core fields', async () => {
    const snap = await snapshotOf(
      product(58113, 'Віскі Jameson', { price: 649, old: 899 }),
    );

    expect(snap).toBeDefined();
    expect(snap?.storeSlug).toBe('silpo');
    expect(snap?.storeSku).toBe('58113');
    expect(snap?.url).toBe('https://silpo.ua/product/viski-58113');
    expect(snap?.name).toBe('Віскі Jameson');
    expect(snap?.brand).toBe('Jameson');
    expect(snap?.price).toBe(649);
    expect(snap?.oldPrice).toBe(899);
    expect(snap?.promo).toBe(true);
    expect(snap?.volumeMl).toBe(700);
    expect(snap?.inStock).toBe(true);
  });

  it('ignores an old price at or below the current one', async () => {
    const snap = await snapshotOf(
      product(1, 'Віскі X', { price: 500, old: 400 }),
    );

    expect(snap?.oldPrice).toBeNull();
    expect(snap?.promo).toBe(false);
  });

  it('flags zero and null stock as out of stock', async () => {
    const zero = await snapshotOf(product(1, 'A', { stock: 0 }));
    const nulled = await snapshotOf(product(2, 'B', { stock: null }));
    const positive = await snapshotOf(product(3, 'C', { stock: 51 }));

    expect(zero?.inStock).toBe(false);
    expect(nulled?.inStock).toBe(false);
    expect(positive?.inStock).toBe(true);
  });

  it('reads the volume from the display ratio only', async () => {
    const litre = await snapshotOf(product(1, 'A', { ratio: '1л' }));
    const piece = await snapshotOf(product(2, 'B', { ratio: 'шт' }));
    const missing = await snapshotOf(product(3, 'C', { ratio: null }));

    expect(litre?.volumeMl).toBe(1000);
    expect(piece?.volumeMl).toBeNull();
    expect(missing?.volumeMl).toBeNull();
  });

  it('falls back to the slug when the numeric id is missing', async () => {
    const raw = product(7, 'Віскі Y');

    raw.externalProductId = null;

    const snap = await snapshotOf(raw);

    expect(snap?.storeSku).toBe('viski-7');
  });

  it('skips an item without a price, slug or name', async () => {
    const priceless = product(1, 'A');
    const slugless = product(2, 'B');
    const nameless = product(3, '');

    priceless.price = 0;
    slugless.slug = null;

    const { adapter } = makeAdapter(
      { 1: [priceless, slugless, nameless, product(4, 'D')] },
      4,
    );

    const snaps = await adapter.fetchListing();

    expect(snaps.map((snap) => snap.storeSku)).toEqual(['4']);
  });

  it('walks every page the total implies and deduplicates', async () => {
    const first = Array.from(
      { length: PAGE_SIZE },
      (_, i) => product(i, `Item ${i}`),
    );

    const { adapter, http } = makeAdapter(
      { 1: first, 2: [product(0, 'Item 0'), product(200, 'Item 200')] },
      PAGE_SIZE + 2,
    );

    const snaps = await adapter.fetchListing();

    expect(snaps).toHaveLength(PAGE_SIZE + 1);
    expect(http.calls.map((call) => call.params.offset)).toEqual([
      0,
      PAGE_SIZE,
    ]);
  });

  it('keeps the pages it already has when a later page fails', async () => {
    const http = new FakeHttpClient((_url, options) => {
      if (Number(options?.params?.offset) === 0) {
        return { body: { total: 300, items: [product(1, 'A')] } };
      }

      throw new Error('502');
    });
    const adapter = new SilpoAdapter(SPEC, 1, http, new NormalizeService());

    const snaps = await adapter.fetchListing();

    expect(snaps.map((snap) => snap.storeSku)).toEqual(['1']);
  });

  it('fails when the very first page fails', async () => {
    const http = new FakeHttpClient(() => {
      throw new Error('502');
    });
    const adapter = new SilpoAdapter(SPEC, 1, http, new NormalizeService());

    await expect(adapter.fetchListing()).rejects.toThrow('502');
  });
});
