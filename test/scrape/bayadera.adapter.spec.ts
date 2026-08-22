import 'reflect-metadata';

import { BayaderaAdapter } from '../../src/scrape/adapters/bayadera';
import { NormalizeService } from '../../src/scrape/normalize/normalize.service';
import { FakeHttpClient } from './fake-http-client';

import type { StoreScrapeSpec } from '~types';

const SPEC: StoreScrapeSpec = {
  slug: 'bayadera',
  name: 'Bayadera',
  baseUrl: 'https://bayadera.ua',
  tier: 1,
  needsBrowser: false,
  retailChain: null,
  category: null,
  delayFrom: 0,
  delayTo: 0,
};

const LISTING = 'https://bayadera.ua/category/strong-alcohol/whiskey';

/**
 * The fields one fake card is built from.
 */
interface CardInput {
  /**
   * Store article code, the SKU.
   */
  article?: string;

  /**
   * Numeric product id, the SKU fallback.
   */
  id?: number;

  /**
   * Product name; goes into the JSON payload verbatim.
   */
  name?: string;

  /**
   * Current price in kopecks, as the site serializes it.
   */
  price?: number;

  /**
   * Root-relative product link.
   */
  link?: string;

  /**
   * Displayed pack size (`0.7 л`).
   */
  volume?: string;

  /**
   * Brand value, possibly category-prefixed.
   */
  brand?: string;

  /**
   * Unlabeled characteristic values.
   */
  attributes?: string[];

  /**
   * Struck-through pre-discount price text, rendered only when set.
   */
  oldPriceText?: string;

  /**
   * The `data-is-in-stock` flag; defaults to in stock.
   */
  inStock?: boolean;

  /**
   * Extra class on the card wrapper (`slide` marks a top-sales slider card).
   */
  wrapperClass?: string;
}

/**
 * Builds one product card the way the live site renders it on 2026-08-10:
 * the wrapper div, the struck-through old price when discounted, and the buy
 * button whose single-quoted `data-product-info` attribute holds the item as
 * JSON with `'`-escaped apostrophes.
 *
 * @param input - The card's fields.
 * @returns The card's HTML.
 */
function card(input: CardInput = {}): string {
  const {
    article = '1WS-WGM070-050',
    id = 4592,
    name = 'Віскі Glenmorangie The Original 12 YO 0.7л у подарунковій коробці',
    price = 199900,
    link = '/product/vsk-glenmorangie-original-12-rokv-podarunk',
    volume = '0.7 л',
    brand = 'Віскі Glenmorangie',
    attributes = ['0.7 л', 'Золотистий', 'Шотландія', '40%', 'Вершковий'],
    oldPriceText,
    inStock = true,
    wrapperClass = '',
  } = input;
  const info = JSON.stringify({
    attributes,
    volume,
    price,
    id,
    article,
    name,
    brand,
    link,
  }).replace(/'/g, '\\u0027');
  const oldPrice = oldPriceText === undefined
    ? ''
    : `<div class="goodCost old">${oldPriceText}</div>
       <div class="productLabel">-39%</div>`;

  return `<div class="goodWr goodJs ${wrapperClass}">
    <div class="goodHoverWr goodHoverJs" data-productKey="${String(id)}">
      <div class="goodImageWr"><a href="${link}"><img alt="x"></a></div>
      <div class="goodText">
        <div class="goodTitle b"><a href="${link}">${name}</a></div>
      </div>
      <div class="goodInfo">
        <div class="goodCostWr"><div>${oldPrice}
          <div class="goodCost">${Math.round(price / 100)} ₴</div>
        </div></div>
        <div class="goodButtons">
          <button class="goodBtnSm addToCartBtnModJs" data-id="${String(id)}"
            data-product-info='${info}'
            data-is-in-stock="${inStock ? '1' : '0'}">
            <span>Купити</span>
          </button>
        </div>
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
  return `<html><body><div class="row mgrid">${cards.join('')}</div>`
    + '</body></html>';
}

/**
 * Builds an adapter over a fake transport. Listing pages are keyed by the
 * `page` query parameter, which is how the store paginates.
 *
 * @param pages - Page number to HTML; page 1 is requested without `page`.
 * @returns The adapter and its fake client.
 */
function adapterOver(
  pages: Record<number, string>,
): { adapter: BayaderaAdapter; http: FakeHttpClient } {
  const http = new FakeHttpClient((url, options) => {
    if (url !== LISTING) {
      throw new Error(`unexpected url ${url}`);
    }

    const html = pages[Number(options?.params?.page ?? 1)];

    if (html === undefined) {
      throw new Error(`unexpected page ${String(options?.params?.page)}`);
    }

    return { text: html };
  });

  return {
    adapter: new BayaderaAdapter(SPEC, 1, http, new NormalizeService()),
    http,
  };
}

describe('BayaderaAdapter.fetchListing', () => {
  it('reads the card out of its data-product-info JSON', async () => {
    const { adapter } = adapterOver({ 1: page(card()), 2: page() });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.storeSku).toBe('1WS-WGM070-050');
    expect(snap.name).toBe(
      'Віскі Glenmorangie The Original 12 YO 0.7л у подарунковій коробці',
    );
    expect(snap.price).toBe(1999);
    expect(snap.oldPrice).toBeNull();
    expect(snap.promo).toBe(false);
    expect(snap.inStock).toBe(true);
    expect(snap.volumeMl).toBe(700);
    expect(snap.abv).toBe(40);
    expect(snap.url).toBe(
      'https://bayadera.ua/product/vsk-glenmorangie-original-12-rokv-podarunk',
    );
    expect(snap.rawAttrs.attributes).toBe(
      '0.7 л, Золотистий, Шотландія, 40%, Вершковий',
    );
  });

  it('strips the category word off a prefixed brand', async () => {
    const { adapter } = adapterOver({
      1: page(
        card(),
        card({ article: '2', brand: 'Johnnie Walker' }),
        card({ article: '3', brand: 'Віскі' }),
      ),
      2: page(),
    });

    const { items: snaps } = await adapter.fetchListing();

    expect(snaps.map((snap) => snap.brand)).toEqual([
      'Glenmorangie',
      'Johnnie Walker',
      null,
    ]);
  });

  it('decodes a \\u0027-escaped apostrophe in the payload', async () => {
    const { adapter } = adapterOver({
      1: page(card({
        article: '1WS-WJD300-002',
        name: "Віскі Jack Daniel's Tennessee Old No.7 3л 40%",
        brand: "Jack Daniel's",
      })),
      2: page(),
    });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.name).toBe("Віскі Jack Daniel's Tennessee Old No.7 3л 40%");
    expect(snap.brand).toBe("Jack Daniel's");
  });

  it(
    'reads a discount as kopeck price plus struck-through old text',
    async () => {
      const { adapter } = adapterOver({
        1: page(card({
          article: '1WS-JWR100-005',
          price: 75900,
          oldPriceText: '1 239 ₴',
        })),
        2: page(),
      });

      const { items: [snap] } = await adapter.fetchListing();

      expect(snap.price).toBe(759);
      expect(snap.oldPrice).toBe(1239);
      expect(snap.promo).toBe(true);
    },
  );

  it('flags an out-of-stock card instead of dropping it', async () => {
    const { adapter } = adapterOver({
      1: page(card({ inStock: false })),
      2: page(),
    });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.inStock).toBe(false);
  });

  it('ignores the top-sales slider cards', async () => {
    const { adapter } = adapterOver({
      1: page(
        card(),
        card({ article: 'SLIDER-ONLY', wrapperClass: 'slide' }),
      ),
      2: page(),
    });

    const { items: snaps } = await adapter.fetchListing();

    expect(snaps.map((snap) => snap.storeSku)).toEqual(['1WS-WGM070-050']);
  });

  it('falls back to the numeric id when the article is empty', async () => {
    const { adapter } = adapterOver({
      1: page(card({ article: '', id: 4592 })),
      2: page(),
    });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.storeSku).toBe('4592');
  });

  it('drops a card without a name or a usable price', async () => {
    const { adapter } = adapterOver({
      1: page(
        card({ name: '' }),
        card({ article: '2', price: 0 }),
      ),
    });

    const { items } = await adapter.fetchListing();

    expect(items).toEqual([]);
  });

  it(
    'paginates with ?page=N, deduplicates and stops on a repeat page',
    async () => {
      const { adapter, http } = adapterOver({
        1: page(card(), card({ article: '2' })),
        2: page(card({ article: '2' }), card({ article: '3' })),
        3: page(card(), card({ article: '3' })),
      });

      const { items: snaps } = await adapter.fetchListing();

      expect(snaps.map((snap) => snap.storeSku)).toEqual([
        '1WS-WGM070-050',
        '2',
        '3',
      ]);
      expect(http.calls.map((call) => call.params.page)).toEqual([
        undefined,
        2,
        3,
      ]);
    },
  );
});
