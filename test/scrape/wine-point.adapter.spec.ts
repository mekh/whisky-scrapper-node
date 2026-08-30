import 'reflect-metadata';

import { ListingStop } from '~enums';

import { WinePointAdapter } from '../../src/scrape/adapters/wine-point';
import { NormalizeService } from '../../src/scrape/normalize/normalize.service';
import { FakeHttpClient } from './fake-http-client';

import type { ProductSnapshot, StoreScrapeSpec } from '~types';

const SPEC: StoreScrapeSpec = {
  slug: 'wine-point',
  name: 'Wine Point',
  baseUrl: 'https://wine-point.ua',
  tier: 1,
  needsBrowser: false,
  retailChain: null,
  category: null,
  delayFrom: 0,
  delayTo: 0,
};

const LISTING = 'https://wine-point.ua/whiskey/';

const REGULAR = '<div class="product-price-regular">'
  + '<span class="woocommerce-Price-amount"><bdi>80&nbsp;<span>₴</span></bdi>'
  + '</span></div>';

/**
 * A promoted item: the current price, the struck-through old price and the
 * `<mark>` holding the discount amount, which must never be read as a price.
 */
const SALE = '<div class="product-price-sale">'
  + '<span class="woocommerce-Price-amount"><bdi>99&nbsp;<span>₴</span></bdi>'
  + '</span></div>'
  + '<div class="product-price-regular-discount">'
  + '<s><span class="woocommerce-Price-amount"><bdi>118&nbsp;<span>₴</span>'
  + '</bdi></span></s>'
  + '<mark><span class="woocommerce-Price-amount"><bdi>-19&nbsp;<span>₴</span>'
  + '</bdi></span></mark></div>';

/**
 * A bulk-tier block: the single-bottle price plus the 3+ / 6+ prices.
 */
const TIER = '<div class="product-price-regular-sale3-sale6">'
  + '<span class="price_regular"><span class="woocommerce-Price-amount">'
  + '<bdi>299&nbsp;<span>₴</span></bdi></span></span>'
  + '<span class="price_sale3"><span class="woocommerce-Price-amount">'
  + '<bdi>278&nbsp;<span>₴</span></bdi></span></span>'
  + '<span class="price_sale6"><span class="woocommerce-Price-amount">'
  + '<bdi>263&nbsp;<span>₴</span></bdi></span></span></div>';

const DETAIL = `<html><body>
  <table class="woocommerce-product-attributes">
    <tr><th>Виробник</th><td>Ballantine's</td></tr>
    <tr><th>Країна</th><td>Шотландія</td></tr>
    <tr><th>Об'єм</th><td>0,05</td></tr>
    <tr><th>Міцність</th><td>40%</td></tr>
    <tr><th>Тип</th><td>Бленд</td></tr>
    <tr><th>Торгова Марка</th><td>Ballantine's</td></tr>
  </table></body></html>`;

/**
 * Builds one listing card, mirroring the Python adapter's test fixture.
 *
 * @param sku - Product id used as the SKU.
 * @param title - Product title.
 * @param priceBlock - The card's price markup.
 * @param over - Stock / promotion class overrides.
 * @returns The card's HTML.
 */
function card(
  sku: string,
  title: string,
  priceBlock: string,
  over: { oos?: boolean; sale?: boolean } = {},
): string {
  const stock = over.oos === true ? 'outofstock' : 'instock';
  const sale = over.sale === true ? ' sale' : '';
  const href = `${LISTING}${sku}/`;

  return `<div class="product type-product ${stock} product_cat-whiskey${sale}">
    <a class="woocommerce-LoopProduct-link" href="${href}">
      <span class="woocommerce-loop-product__title">${title}</span>
    </a>
    <div class="product-price-button-container">
      <div class="product-price">${priceBlock}</div>
      <div class="product-add-to-cart">
        <a href="/whiskey/?add-to-cart=${sku}" data-product_id="${sku}"
           class="button product_type_simple add_to_cart_button">В кошик</a>
      </div>
    </div>
  </div>`;
}

/**
 * Wraps cards into one listing page.
 *
 * @param cards - The page's cards.
 * @returns The page's HTML.
 */
function page(...cards: string[]): string {
  return `<html><body><ul class='products'>${cards.join('')}</ul>`
    + '</body></html>';
}

/**
 * Builds an adapter over a fake transport serving the given pages by URL.
 *
 * @param pages - URL to page HTML.
 * @returns The adapter and its fake client.
 */
function adapterOver(pages: Record<string, string>): {
  adapter: WinePointAdapter;
  http: FakeHttpClient;
} {
  const http = new FakeHttpClient((url) => {
    const html = pages[url];

    if (html === undefined) {
      throw new Error(`unexpected url ${url}`);
    }

    return { text: html };
  });

  return {
    adapter: new WinePointAdapter(SPEC, 1, http, new NormalizeService()),
    http,
  };
}

/**
 * Parses a single card through a one-page listing.
 *
 * @param html - The card's HTML.
 * @returns The parsed snapshot.
 */
async function parseOne(html: string): Promise<ProductSnapshot> {
  const { adapter } = adapterOver({ [LISTING]: page(html) });
  const { items: snaps } = await adapter.fetchListing();

  return snaps[0];
}

describe('WinePointAdapter.fetchListing', () => {
  it('reads a regular price', async () => {
    const snap = await parseOne(card('1', 'Віскі A 0,05л', REGULAR));

    expect(snap.price).toBe(80);
    expect(snap.oldPrice).toBeNull();
    expect(snap.promo).toBe(false);
    expect(snap.inStock).toBe(true);
    expect(snap.storeSku).toBe('1');
    expect(snap.url).toBe('https://wine-point.ua/whiskey/1/');
  });

  it('takes the sale price and ignores the discount mark', async () => {
    const snap = await parseOne(card('2', 'Віскі B', SALE, { sale: true }));

    expect(snap.price).toBe(99);
    expect(snap.oldPrice).toBe(118);
    expect(snap.promo).toBe(true);
  });

  it('takes the single-unit price out of a bulk-tier block', async () => {
    const snap = await parseOne(card('3', 'Віскі C', TIER));

    expect(snap.price).toBe(299);
    expect(snap.oldPrice).toBeNull();
  });

  it('marks an out-of-stock card', async () => {
    const snap = await parseOne(card('4', 'Віскі D', REGULAR, { oos: true }));

    expect(snap.inStock).toBe(false);
  });

  it('deduplicates across pages and stops on an empty one', async () => {
    const { adapter, http } = adapterOver({
      [LISTING]: page(
        card('1', 'A', REGULAR),
        card('2', 'B', SALE, { sale: true }),
      ),
      [`${LISTING}page/2/`]: page(
        card('2', 'B', SALE, { sale: true }),
        card('3', 'C', TIER),
      ),
      [`${LISTING}page/3/`]: page(),
    });

    const { items: snaps } = await adapter.fetchListing();

    expect(snaps.map((snap) => snap.storeSku).sort()).toEqual(['1', '2', '3']);
    expect(http.calls).toHaveLength(3);
  });

  it('keeps the pages collected before a later page fails', async () => {
    const { adapter } = adapterOver({
      [LISTING]: page(card('1', 'A', REGULAR)),
    });

    const listing = await adapter.fetchListing();

    expect(listing.items.map((snap) => snap.storeSku)).toEqual(['1']);
    /**
     * The pages are worth keeping — their prices are real — but the walk
     * never saw the rest of the catalogue, so persist must not read the
     * absentees as sold out.
     */
    expect(listing.complete).toBe(false);
    expect(listing.stop).toBe(ListingStop.PAGE_FAILED);
  });

  it('propagates a first-page failure', async () => {
    const { adapter } = adapterOver({});

    await expect(adapter.fetchListing()).rejects.toThrow('unexpected url');
  });
});

describe('WinePointAdapter.enrichDetail', () => {
  it('maps the specification table onto the snapshot', async () => {
    const url = 'https://wine-point.ua/whiskey/x/';
    const { adapter } = adapterOver({ [url]: DETAIL });
    const snap = {
      storeSlug: 'wine-point',
      storeSku: '1',
      url,
      name: 'Віскі',
      price: 80,
      brand: null,
      oldPrice: null,
      currency: 'UAH',
      inStock: true,
      promo: false,
      volumeMl: null,
      abv: null,
      ageYears: null,
      whiskyType: null,
      country: null,
      flavorTags: [],
      rawAttrs: {},
      factSources: {},
    };

    await expect(adapter.enrichDetail(snap)).resolves.toBe(true);

    expect(snap.country).toBe('Шотландія');
    expect(snap.brand).toBe("Ballantine's");
    expect(snap.whiskyType).toBe('blend');
    expect(snap.abv).toBe(40);
    expect(snap.volumeMl).toBe(50);
  });

  it('reports no detail for an item without a URL', async () => {
    const { adapter } = adapterOver({});

    const enriched = await adapter.enrichDetail({
      url: '',
    } as unknown as ProductSnapshot);

    expect(enriched).toBe(false);
  });
});
