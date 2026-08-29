import 'reflect-metadata';

import { GoodwineAdapter } from '../../src/scrape/adapters/goodwine';
import { NormalizeService } from '../../src/scrape/normalize/normalize.service';
import { FakeHttpClient } from './fake-http-client';

import type { ProductSnapshot, StoreScrapeSpec } from '~types';

const SPEC: StoreScrapeSpec = {
  slug: 'goodwine',
  name: 'Goodwine',
  baseUrl: 'https://goodwine.com.ua',
  tier: 2,
  needsBrowser: false,
  retailChain: null,
  category: null,
  delayFrom: 0,
  delayTo: 0,
};

const LISTING = 'https://goodwine.com.ua/ua/napoi/viski/';

/**
 * The product page's specification list, trimmed from a live page captured on
 * 2026-07-25. Every item nests the label in its own `<span>`, so the label and
 * value are separate text nodes with source whitespace between them — the
 * `Label:Value` split only works on text stripped node by node.
 */
const DETAIL = `<html><body><ul>
  <li class="product-attr-item flex"> <span> <span>Країна:</span> Ірландія
    </span> </li>
  <li class="product-attr-item flex"> <span> <span>Ємність:</span> 0.7</span>
  </li>
  <li class="product-attr-item flex"> <span> <span>Міцність, %:</span> 40
    </span> </li>
  <li class="product-attr-item flex"> <span> <span>Тип віскі:</span> Бленд
    </span> </li>
  <li class="product-attr-item flex"> <span> <span>Торгова марка:</span>
    <a href="/ua/napoi/viski/f/producer-jameson/">Jameson</a></span> </li>
</ul></body></html>`;

/**
 * Builds one product card: a Magento `<form>` whose `data-*` attributes hold
 * the whole item. The first link is a real copy of the product URL with a
 * leading space, which the legacy adapter skips — so this adapter must too.
 *
 * @param over - Attribute overrides for the card.
 * @returns The card's HTML.
 */
function card(over: Record<string, string> = {}): string {
  const attributes: Record<string, string> = {
    'data-product-id': '4352',
    'data-sku': '60531',
    'data-name': 'Віскі Jameson, 0.7 л',
    'data-price': '814.130000',
    'data-finalprice': '814.13',
    'data-brand': 'Jameson',
    'data-category': 'Напої',
    'data-category2': 'Віскі',
    'data-category3': 'Країни',
    'data-category4': 'Ірландія',
    ...over,
  };
  const rendered = Object.entries(attributes)
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');
  const url = `https://goodwine.com.ua/ua/product-${attributes['data-sku']}/`;

  return `<form method="post" ${rendered}
    action="https://goodwine.com.ua/ua/checkout/cart/add/product/4352/"
    class="item product product-item">
    <a href=" ${url}" class="product photo"><img alt="x"></a>
    <a href="${url}" class="product-item-link">${attributes['data-name']}</a>
    <a href="https://goodwine.com.ua/ua/checkout/cart/">Кошик</a>
  </form>`;
}

/**
 * Wraps cards into one listing page.
 *
 * @param cards - The page's cards.
 * @returns The page's HTML.
 */
function page(...cards: string[]): string {
  return `<html><body><div class="products">${cards.join('')}</div>`
    + '</body></html>';
}

/**
 * Builds an adapter over a fake transport. Listing pages are keyed by the `p`
 * query parameter, which is how the store paginates.
 *
 * @param pages - Page number to HTML; page 1 is requested without `p`.
 * @param detail - Optional product-page HTML, served for any other URL.
 * @returns The adapter and its fake client.
 */
function adapterOver(
  pages: Record<number, string>,
  detail?: string,
): { adapter: GoodwineAdapter; http: FakeHttpClient } {
  const http = new FakeHttpClient((url, options) => {
    if (url !== LISTING) {
      if (detail === undefined) {
        throw new Error(`unexpected url ${url}`);
      }

      return { text: detail };
    }

    const html = pages[Number(options?.params?.p ?? 1)];

    if (html === undefined) {
      throw new Error(`unexpected page ${String(options?.params?.p)}`);
    }

    return { text: html };
  });

  return {
    adapter: new GoodwineAdapter(SPEC, 1, http, new NormalizeService()),
    http,
  };
}

describe('GoodwineAdapter.fetchListing', () => {
  it('reads the card out of its data attributes', async () => {
    const { adapter } = adapterOver({ 1: page(card()), 2: page() });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.storeSku).toBe('60531');
    expect(snap.name).toBe('Віскі Jameson, 0.7 л');
    expect(snap.price).toBe(814.13);
    expect(snap.oldPrice).toBeNull();
    expect(snap.promo).toBe(false);
    expect(snap.brand).toBe('Jameson');
    expect(snap.country).toBe('Ірландія');
    expect(snap.inStock).toBe(true);
  });

  it('skips the cart link and the copy with a leading space', async () => {
    const { adapter } = adapterOver({ 1: page(card()), 2: page() });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.url).toBe('https://goodwine.com.ua/ua/product-60531/');
  });

  it(
    'reads a promotion as final price plus struck-through regular',
    async () => {
      const { adapter } = adapterOver({
        1: page(card({
          'data-sku': '25013',
          'data-price': '2445.650000',
          'data-finalprice': '2149',
        })),
        2: page(),
      });

      const { items: [snap] } = await adapter.fetchListing();

      expect(snap.price).toBe(2149);
      expect(snap.oldPrice).toBe(2445.65);
      expect(snap.promo).toBe(true);
    },
  );

  it('falls back to the regular price when there is no final one', async () => {
    const { adapter } = adapterOver({
      1: page(card({ 'data-finalprice': '' })),
      2: page(),
    });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.price).toBe(814.13);
    expect(snap.oldPrice).toBeNull();
  });

  it('ignores the country when the rubric is not the country one', async () => {
    const { adapter } = adapterOver({
      1: page(card({ 'data-category3': 'Регіони' })),
      2: page(),
    });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.country).toBeNull();
  });

  it('drops a card without a name or a price', async () => {
    const { adapter } = adapterOver({
      1: page(
        card({ 'data-name': '' }),
        card({ 'data-sku': '2', 'data-price': '', 'data-finalprice': '' }),
      ),
    });

    const { items } = await adapter.fetchListing();

    expect(items).toEqual([]);
  });

  it(
    'paginates with ?p=N, deduplicates and stops on an empty page',
    async () => {
      const { adapter, http } = adapterOver({
        1: page(card(), card({ 'data-sku': '2' })),
        2: page(card({ 'data-sku': '2' }), card({ 'data-sku': '3' })),
        3: page(),
      });

      const { items: snaps } = await adapter.fetchListing();

      expect(snaps.map((snap) => snap.storeSku)).toEqual(['60531', '2', '3']);
      expect(http.calls.map((call) => call.params.p)).toEqual([
        undefined,
        2,
        3,
      ]);
    },
  );
});

describe('GoodwineAdapter.enrichDetail', () => {
  it('splits every specification line on its first colon', async () => {
    const { adapter } = adapterOver({}, DETAIL);
    const snap = {
      storeSlug: 'goodwine',
      storeSku: '60531',
      url: 'https://goodwine.com.ua/ua/product-60531/',
      name: 'Віскі Jameson, 0.7 л',
      price: 814.13,
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

    expect(snap.country).toBe('Ірландія');
    expect(snap.volumeMl).toBe(700);
    expect(snap.abv).toBe(40);
    expect(snap.whiskyType).toBe('blend');
    expect(snap.brand).toBe('Jameson');
  });

  it('never overwrites a field the listing already filled', async () => {
    const { adapter } = adapterOver({}, DETAIL);
    const snap = {
      url: 'https://goodwine.com.ua/ua/product-60531/',
      brand: 'Manual',
      country: 'Шотландія',
      whiskyType: 'single malt',
      abv: 43,
      volumeMl: 500,
    } as unknown as ProductSnapshot;

    await adapter.enrichDetail(snap);

    expect(snap.brand).toBe('Manual');
    expect(snap.country).toBe('Шотландія');
    expect(snap.whiskyType).toBe('single malt');
    expect(snap.abv).toBe(43);
    expect(snap.volumeMl).toBe(500);
  });

  it('reports no detail when the page has no specification list', async () => {
    const { adapter } = adapterOver({}, '<html><body>404</body></html>');

    const enriched = await adapter.enrichDetail({
      url: 'https://goodwine.com.ua/ua/product-60531/',
    } as unknown as ProductSnapshot);

    expect(enriched).toBe(false);
  });
});
