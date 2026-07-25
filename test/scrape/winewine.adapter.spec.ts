import 'reflect-metadata';

import { WinewineAdapter } from '../../src/scrape/adapters/winewine';
import { NormalizeService } from '../../src/scrape/normalize/normalize.service';
import { FakeHttpClient } from './fake-http-client';

import type { ProductSnapshot, StoreScrapeSpec } from '~types';

const SPEC: StoreScrapeSpec = {
  slug: 'winewine',
  name: 'WineWine',
  baseUrl: 'https://winewine.ua',
  tier: 1,
  needsBrowser: false,
  retailChain: null,
  category: null,
  delayFrom: 0,
  delayTo: 0,
};

const LISTING = 'https://winewine.ua/whiskey/';

/**
 * Promoted item: the previous price in `<del>`, the current one in `<ins>`.
 * The screen-reader copies of both are real markup and must not be read as
 * prices. Trimmed from a live listing page captured on 2026-07-25.
 */
const SALE_PRICE = '<span class="price">'
  + '<del aria-hidden="true"><span class="woocommerce-Price-amount amount">'
  + '<bdi>614&nbsp;<span class="woocommerce-Price-currencySymbol">грн</span>'
  + '</bdi></span></del>'
  + '<span class="screen-reader-text">Оригінальна ціна: 614&nbsp;грн.</span>'
  + '<ins aria-hidden="true"><span class="woocommerce-Price-amount amount">'
  + '<bdi>389&nbsp;<span class="woocommerce-Price-currencySymbol">грн</span>'
  + '</bdi></span></ins>'
  + '<span class="screen-reader-text">Поточна ціна: 389&nbsp;грн.</span>'
  + '</span>';

const PLAIN_PRICE = '<span class="price">'
  + '<span class="woocommerce-Price-amount amount">'
  + '<bdi>1&nbsp;729&nbsp;<span class="woocommerce-Price-currencySymbol">грн'
  + '</span></bdi></span></span>';

/**
 * The live specification table: `Алкоголь` carries the exact strength while
 * `Міцність` carries a range, and every value is wrapped in a filter link.
 */
const DETAIL = `<html><body>
  <table class="woocommerce-product-attributes shop_attributes">
    <tr class="woocommerce-product-attributes-item">
      <th class="woocommerce-product-attributes-item__label">Країна</th>
      <td class="woocommerce-product-attributes-item__value">
        <a href="/whiskey/country_shotlandiia/">Шотландія</a></td>
    </tr>
    <tr><th>Літраж</th><td><a href="/whiskey/capacity_0-7/">0.7</a></td></tr>
    <tr><th>Бренд</th><td><a href="/whiskey/brand_bells/">Bells</a></td></tr>
    <tr><th>Тип</th><td><a href="/whiskey/kind_blend/">бленд</a></td></tr>
    <tr><th>Алкоголь</th><td>40%</td></tr>
    <tr><th>Категорія</th><td>Віскі</td></tr>
    <tr><th>Міцність</th><td><a href="/whiskey/strength_37-43/">37-43%</a></td>
    </tr>
  </table></body></html>`;

/**
 * Builds one listing card in the store's real markup: the title sits in a
 * nested `<span>` and the SKU is the add-to-cart button's `data-product_id`.
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

  return `<li class="product type-product post-${sku} ${stock}`
    + ` product_cat-whiskey${sale} purchasable product-type-simple">
    <a href="${href}" class="woocommerce-LoopProduct-link">
      <span class="onsale">Розпродаж!</span>
      <span class="woocommerce-loop-product__title"><span>${title}</span></span>
      ${priceBlock}
    </a>
    <a data-price="389" href="/whiskey/?add-to-cart=${sku}"
       class="button add_to_cart_button" data-product_id="${sku}"
       data-product_sku="2899"><span class="button-text">Купити</span></a>
  </li>`;
}

/**
 * Wraps cards into one listing page.
 *
 * @param cards - The page's cards.
 * @returns The page's HTML.
 */
function page(...cards: string[]): string {
  return `<html><body><ul class="products">${cards.join('')}</ul>`
    + '</body></html>';
}

/**
 * Builds an adapter over a fake transport serving the given pages by URL.
 *
 * @param pages - URL to page HTML.
 * @returns The adapter and its fake client.
 */
function adapterOver(pages: Record<string, string>): {
  adapter: WinewineAdapter;
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
    adapter: new WinewineAdapter(SPEC, 1, http, new NormalizeService()),
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
  const snaps = await adapter.fetchListing();

  return snaps[0];
}

describe('WinewineAdapter.fetchListing', () => {
  it(
    'reads a promoted card from ins/del, ignoring the reader copies',
    async () => {
      const snap = await parseOne(
        card('10397', 'Bell’s Original віскі бленд 0.7л', SALE_PRICE, {
          sale: true,
        }),
      );

      expect(snap.storeSku).toBe('10397');
      expect(snap.url).toBe('https://winewine.ua/whiskey/10397/');
      expect(snap.name).toBe('Bell’s Original віскі бленд 0.7л');
      expect(snap.price).toBe(389);
      expect(snap.oldPrice).toBe(614);
      expect(snap.promo).toBe(true);
      expect(snap.inStock).toBe(true);
    },
  );

  it('reads a single price and drops the thousands separator', async () => {
    const snap = await parseOne(card('10438', 'Віскі B', PLAIN_PRICE));

    expect(snap.price).toBe(1729);
    expect(snap.oldPrice).toBeNull();
    expect(snap.promo).toBe(false);
  });

  it('marks an out-of-stock card', async () => {
    const snap = await parseOne(
      card('10439', 'Віскі C', PLAIN_PRICE, { oos: true }),
    );

    expect(snap.inStock).toBe(false);
  });

  it('drops a card with no parseable price', async () => {
    const { adapter } = adapterOver({
      [LISTING]: page(card('1', 'Віскі D', '<span class="price">—</span>')),
    });

    await expect(adapter.fetchListing()).resolves.toEqual([]);
  });

  it('deduplicates across pages and stops on an empty one', async () => {
    const { adapter, http } = adapterOver({
      [LISTING]: page(card('1', 'A', PLAIN_PRICE), card('2', 'B', SALE_PRICE)),
      [`${LISTING}page/2/`]: page(
        card('2', 'B', SALE_PRICE),
        card('3', 'C', PLAIN_PRICE),
      ),
      [`${LISTING}page/3/`]: page(),
    });

    const snaps = await adapter.fetchListing();

    expect(snaps.map((snap) => snap.storeSku)).toEqual(['1', '2', '3']);
    expect(http.calls).toHaveLength(3);
  });

  it('keeps the pages collected before a later page fails', async () => {
    const { adapter } = adapterOver({
      [LISTING]: page(card('1', 'A', PLAIN_PRICE)),
    });

    const snaps = await adapter.fetchListing();

    expect(snaps.map((snap) => snap.storeSku)).toEqual(['1']);
  });

  it('propagates a first-page failure', async () => {
    const { adapter } = adapterOver({});

    await expect(adapter.fetchListing()).rejects.toThrow('unexpected url');
  });
});

describe('WinewineAdapter.enrichDetail', () => {
  it(
    'prefers the exact strength over the range and fills the rest',
    async () => {
      const url = 'https://winewine.ua/whiskey/x/';
      const { adapter } = adapterOver({ [url]: DETAIL });
      const snap = {
        storeSlug: 'winewine',
        storeSku: '1',
        url,
        name: 'Віскі',
        price: 389,
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
      };

      await expect(adapter.enrichDetail(snap)).resolves.toBe(true);

      expect(snap.country).toBe('Шотландія');
      expect(snap.brand).toBe('Bells');
      expect(snap.whiskyType).toBe('blend');
      expect(snap.abv).toBe(40);
      expect(snap.volumeMl).toBe(700);
    },
  );

  it('never overwrites a field the listing already filled', async () => {
    const url = 'https://winewine.ua/whiskey/x/';
    const { adapter } = adapterOver({ [url]: DETAIL });
    const snap = {
      url,
      brand: 'Manual',
      country: 'Ірландія',
      whiskyType: 'single malt',
      abv: 43,
      volumeMl: 500,
    } as unknown as ProductSnapshot;

    await adapter.enrichDetail(snap);

    expect(snap.brand).toBe('Manual');
    expect(snap.country).toBe('Ірландія');
    expect(snap.whiskyType).toBe('single malt');
    expect(snap.abv).toBe(43);
    expect(snap.volumeMl).toBe(500);
  });

  it('reports no detail when the page has no attribute table', async () => {
    const url = 'https://winewine.ua/whiskey/x/';
    const { adapter } = adapterOver({ [url]: '<html><body>404</body></html>' });

    const enriched = await adapter.enrichDetail({
      url,
    } as unknown as ProductSnapshot);

    expect(enriched).toBe(false);
  });
});
