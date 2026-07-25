import 'reflect-metadata';

import { NormalizeService } from '../../src/scrape/normalize/normalize.service';
import { ZakazAdapter } from '../../src/scrape/adapters/zakaz';
import { FakeHttpClient } from './fake-http-client';

import type { ProductSnapshot, StoreScrapeSpec } from '~types';
import type {
  ZakazProduct,
} from '../../src/scrape/adapters/zakaz/zakaz.interfaces';

const STORES_URL = 'https://stores-api.zakaz.ua/stores/';

const SPEC: StoreScrapeSpec = {
  slug: 'metro',
  name: 'Metro',
  baseUrl: 'https://metro.zakaz.ua',
  tier: 1,
  needsBrowser: false,
  retailChain: 'metro',
  category: 'whiskey-metro',
  delayFrom: 0,
  delayTo: 0,
};

/**
 * Builds one API product, mirroring the Python test fixture.
 *
 * @param ean - Barcode used as the SKU.
 * @param title - Product title.
 * @param over - Price / stock / volume overrides.
 * @returns The raw product.
 */
function product(
  ean: string,
  title: string,
  over: {
    price?: number | null;
    old?: number | null;
    inStock?: boolean;
    volume?: number | null;
  } = {},
): ZakazProduct {
  const price = over.price === undefined ? 100000 : over.price;
  const old = over.old ?? null;

  return {
    ean,
    sku: `sku-${ean}`,
    title,
    price,
    discount: {
      status: Boolean(old),
      old_price: old ?? price,
      value: 10,
    },
    volume: over.volume === undefined ? 700 : over.volume,
    producer: { trademark: 'Jameson' },
    country: 'Ірландія',
    web_url: `https://metro.zakaz.ua/uk/products/${ean}/`,
    in_stock: over.inStock ?? true,
  };
}

/**
 * Builds an adapter over a fake API serving the given pages.
 *
 * @param pages - Products per 1-based page number.
 * @param spec - Overrides for the store spec.
 * @returns The adapter and the fake client it uses.
 */
function makeAdapter(
  pages: Record<number, ZakazProduct[]>,
  spec: Partial<StoreScrapeSpec> = {},
): { adapter: ZakazAdapter; http: FakeHttpClient } {
  const merged = { ...SPEC, ...spec };
  const http = new FakeHttpClient((url, options) => {
    if (url === STORES_URL) {
      return {
        body: [
          { id: 'other-1', retail_chain: 'auchan' },
          { id: 'store-1', retail_chain: merged.retailChain },
        ],
      };
    }

    const page = Number(options?.params?.page);

    return { body: { results: pages[page] ?? [] } };
  });

  const adapter = new ZakazAdapter(merged, 1, http, new NormalizeService());

  return { adapter, http };
}

/**
 * Collects a single-product listing and returns that snapshot.
 *
 * @param raw - The raw product to serve on page 1.
 * @returns The mapped snapshot, or undefined when the item was dropped.
 */
async function snapshotOf(
  raw: ZakazProduct,
): Promise<ProductSnapshot | undefined> {
  const { adapter } = makeAdapter({ 1: [raw] });
  const snaps = await adapter.fetchListing();

  return snaps[0];
}

describe('ZakazAdapter', () => {
  it('drives chain and category from the store spec', async () => {
    const { adapter, http } = makeAdapter({ 1: [product('1', 'A')] });

    await adapter.fetchListing();

    expect(http.calls[0].url).toBe(STORES_URL);
    expect(http.calls[1].url).toBe(
      'https://stores-api.zakaz.ua/stores/store-1/categories/'
        + 'whiskey-metro/products/',
    );
  });

  it('keeps the bare whiskey category of the novus exception', async () => {
    const { adapter, http } = makeAdapter(
      { 1: [product('1', 'A')] },
      { slug: 'novus', retailChain: 'novus', category: 'whiskey' },
    );

    await adapter.fetchListing();

    expect(http.calls[1].url).toContain('/categories/whiskey/products/');
  });

  it('converts kopecks, flags the promo and reads the volume', async () => {
    const snap = await snapshotOf(
      product('123', 'Віскі Jameson 0,7л', { price: 76300, old: 88600 }),
    );

    expect(snap).toBeDefined();
    expect(snap?.price).toBe(763);
    expect(snap?.oldPrice).toBe(886);
    expect(snap?.promo).toBe(true);
    expect(snap?.volumeMl).toBe(700);
    expect(snap?.country).toBe('Ірландія');
    expect(snap?.brand).toBe('Jameson');
    expect(snap?.storeSlug).toBe('metro');
    expect(snap?.storeSku).toBe('123');
    expect(snap?.url).toBe('https://metro.zakaz.ua/uk/products/123/');
  });

  it('drops the umbrella country but keeps concrete ones', async () => {
    const umbrella = product('uk', 'Віскі Macallan 0,7л');

    umbrella.country = 'Великобританія';

    const dropped = await snapshotOf(umbrella);
    const kept = await snapshotOf(product('ie', 'X'));

    expect(dropped?.country).toBeNull();
    expect(kept?.country).toBe('Ірландія');
  });

  it('reports no promo when the discount is inactive', async () => {
    const snap = await snapshotOf(
      product('9', 'Віскі X 0,7л', { price: 100000, old: null }),
    );

    expect(snap?.promo).toBe(false);
    expect(snap?.oldPrice).toBeNull();
  });

  it('skips an item without a price', async () => {
    const { adapter } = makeAdapter({
      1: [product('1', 'Віскі Y 0,7л', { price: null })],
    });

    await expect(adapter.fetchListing()).resolves.toEqual([]);
  });

  it('paginates and deduplicates across pages', async () => {
    const { adapter, http } = makeAdapter({
      1: [product('a', 'A'), product('b', 'B', { inStock: false })],
      2: [product('b', 'B', { inStock: false }), product('c', 'C')],
      3: [],
    });

    const snaps = await adapter.fetchListing();

    expect(snaps.map((snap) => snap.storeSku).sort()).toEqual(['a', 'b', 'c']);
    expect(http.pages()).toEqual([1, 2, 3]);
  });

  it('keeps the pages it already has when a later page fails', async () => {
    const http = new FakeHttpClient((url, options) => {
      if (url === STORES_URL) {
        return { body: [{ id: 'store-1', retail_chain: 'metro' }] };
      }

      if (Number(options?.params?.page) === 1) {
        return { body: { results: [product('a', 'A')] } };
      }

      throw new Error('502');
    });
    const adapter = new ZakazAdapter(SPEC, 1, http, new NormalizeService());

    const snaps = await adapter.fetchListing();

    expect(snaps.map((snap) => snap.storeSku)).toEqual(['a']);
  });

  it('fails when the very first page fails', async () => {
    const http = new FakeHttpClient((url) => {
      if (url === STORES_URL) {
        return { body: [{ id: 'store-1', retail_chain: 'metro' }] };
      }

      throw new Error('502');
    });
    const adapter = new ZakazAdapter(SPEC, 1, http, new NormalizeService());

    await expect(adapter.fetchListing()).rejects.toThrow('502');
  });

  it('fails when the chain has no store in the directory', async () => {
    const http = new FakeHttpClient(() => ({
      body: [{ id: 'store-9', retail_chain: 'auchan' }],
    }));
    const adapter = new ZakazAdapter(SPEC, 1, http, new NormalizeService());

    await expect(adapter.fetchListing()).rejects.toThrow('metro');
  });

  it('emits one progress event per page', async () => {
    const events: { page: number; added: number; total: number }[] = [];
    const http = new FakeHttpClient((url, options) => {
      if (url === STORES_URL) {
        return { body: [{ id: 'store-1', retail_chain: 'metro' }] };
      }

      return {
        body: {
          results: Number(options?.params?.page) === 1
            ? [product('a', 'A'), product('b', 'B')]
            : [],
        },
      };
    });
    const adapter = new ZakazAdapter(
      SPEC,
      1,
      http,
      new NormalizeService(),
      (event) => {
        if (event.kind === 'page') {
          events.push({
            page: event.page,
            added: event.added,
            total: event.total,
          });
        }
      },
    );

    await adapter.fetchListing();

    expect(events).toEqual([
      { page: 1, added: 2, total: 2 },
      { page: 2, added: 0, total: 2 },
    ]);
  });
});
