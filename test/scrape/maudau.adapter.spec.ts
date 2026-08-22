import 'reflect-metadata';

import { ListingStop } from '~enums';

import { MaudauAdapter } from '../../src/scrape/adapters/maudau';
import { FakeHttpClient } from './fake-http-client';

import type { ProductSnapshot, StoreScrapeSpec } from '~types';
import type {
  MaudauProduct,
} from '../../src/scrape/adapters/maudau/maudau.interfaces';
import type { FakeHttpReply } from './fake-http-client';

const SPEC: StoreScrapeSpec = {
  slug: 'maudau',
  name: 'MauDau',
  baseUrl: 'https://maudau.com.ua',
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
 * @param slug - URL slug.
 * @param over - Price / availability overrides.
 * @returns The raw product.
 */
function product(
  id: number,
  slug: string,
  over: {
    price?: number | null;
    available?: boolean;
    old?: number | null;
  } = {},
): MaudauProduct {
  return {
    id,
    slug,
    title: `Віскі ${slug}`,
    brand: { slug: 'test-brand' },
    main_category_slug: 'viski',
    offer: {
      price: over.price === undefined ? 10000 : over.price,
      old_price: over.old ?? null,
      available: over.available ?? true,
      discount_percentage: 0,
    },
  };
}

/**
 * Builds an adapter over a fake API serving the given pages.
 *
 * @param pages - Reply per 1-based page number.
 * @returns The adapter and the fake client it uses.
 */
function makeAdapter(
  pages: Record<number, FakeHttpReply>,
): { adapter: MaudauAdapter; http: FakeHttpClient } {
  const http = new FakeHttpClient((_url, options) => {
    const page = Number(options?.params?.page);
    const reply = pages[page];

    if (!reply) {
      throw new Error(`unexpected page ${page}`);
    }

    return reply;
  });

  return { adapter: new MaudauAdapter(SPEC, 1, http), http };
}

/**
 * Collects a single-product listing and returns that snapshot.
 *
 * @param raw - The raw product to serve on page 1.
 * @returns The mapped snapshot, or undefined when the item was dropped.
 */
async function snapshotOf(
  raw: MaudauProduct,
): Promise<ProductSnapshot | undefined> {
  const { adapter } = makeAdapter({
    1: { body: [raw], headers: { 'x-last-page': 'true' } },
  });
  const { items: snaps } = await adapter.fetchListing();

  return snaps[0];
}

describe('MaudauAdapter', () => {
  it('converts kopecks and flags the promo', async () => {
    const snap = await snapshotOf(
      product(1, 'jameson', { price: 58900, old: 69900 }),
    );

    expect(snap).toBeDefined();
    expect(snap?.price).toBe(589);
    expect(snap?.oldPrice).toBe(699);
    expect(snap?.promo).toBe(true);
    expect(snap?.storeSku).toBe('1');
    expect(snap?.url).toBe('https://maudau.com.ua/product/jameson');
    expect(snap?.brand).toBe('test-brand');
  });

  it('skips unavailable and priceless items', async () => {
    const unavailable = await snapshotOf(
      product(2, 'x', { available: false }),
    );
    const priceless = await snapshotOf(product(3, 'y', { price: null }));

    expect(unavailable).toBeUndefined();
    expect(priceless).toBeUndefined();
  });

  it('paginates, filters and deduplicates until the last page', async () => {
    const { adapter, http } = makeAdapter({
      1: {
        body: [
          product(1, 'a'),
          product(2, 'b', { available: false }),
          product(3, 'c'),
        ],
        headers: { 'x-total-pages': '2', 'x-last-page': 'false' },
      },
      2: {
        body: [product(3, 'c'), product(4, 'd')],
        headers: { 'x-total-pages': '2', 'x-last-page': 'true' },
      },
    });

    const { items: snaps } = await adapter.fetchListing();

    expect(snaps.map((snap) => snap.storeSku).sort()).toEqual(['1', '3', '4']);
    expect(http.pages()).toEqual([1, 2]);
  });

  it('stops on the page count when no last-page flag arrives', async () => {
    const { adapter, http } = makeAdapter({
      1: { body: [product(1, 'a')], headers: { 'x-total-pages': '1' } },
    });

    await adapter.fetchListing();

    expect(http.pages()).toEqual([1]);
  });

  it('stops early once the tail stops yielding new items', async () => {
    const headers = { 'x-total-pages': '10', 'x-last-page': 'false' };
    const http = new FakeHttpClient((_url, options) => {
      const page = Number(options?.params?.page);

      return {
        body: page === 1
          ? [product(1, 'a'), product(2, 'b')]
          : [product(100 + page, `oos${page}`, { available: false })],
        headers,
      };
    });
    const adapter = new MaudauAdapter(SPEC, 1, http);

    const listing = await adapter.fetchListing();

    expect(listing.items.map((snap) => snap.storeSku).sort())
      .toEqual(['1', '2']);
    // One productive page plus the two empty ones that trip the early stop.
    expect(http.pages()).toEqual([1, 2, 3]);
    /**
     * The store's own `x-total` counts the unavailable tail this walk never
     * reaches, so completeness cannot be a count here. Pages that carried
     * products of which none were available *are* the tail — the end of the
     * available listing, and the evidence the sweep needs.
     */
    expect(listing.complete).toBe(true);
    expect(listing.stop).toBe(ListingStop.EXHAUSTED);
  });

  /**
   * A page carrying nothing at all is a different animal from a page carrying
   * only sold-out items: the API declined to answer, mid-catalog, and the walk
   * cannot tell that from the catalogue ending.
   */
  it('treats a page with no products at all as inconclusive', async () => {
    const { adapter, http } = makeAdapter({
      1: { body: [product(1, 'a')], headers: { 'x-total-pages': '5' } },
      2: { body: [], headers: { 'x-total-pages': '5' } },
    });

    const listing = await adapter.fetchListing();

    expect(listing.items).toHaveLength(1);
    expect(http.pages()).toEqual([1, 2]);
    expect(listing.complete).toBe(false);
    expect(listing.stop).toBe(ListingStop.AMBIGUOUS);
  });

  it('is complete when the API flags the last page', async () => {
    const { adapter } = makeAdapter({
      1: {
        body: [product(1, 'a')],
        headers: { 'x-total-pages': '5', 'x-last-page': 'true' },
      },
    });

    const listing = await adapter.fetchListing();

    expect(listing.complete).toBe(true);
    expect(listing.stop).toBe(ListingStop.EXHAUSTED);
  });

  it('fails when the API is unreachable', async () => {
    const http = new FakeHttpClient(() => {
      throw new Error('API down');
    });
    const adapter = new MaudauAdapter(SPEC, 1, http);

    await expect(adapter.fetchListing()).rejects.toThrow('API down');
  });
});
