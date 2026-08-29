import 'reflect-metadata';

import { ListingStop } from '~enums';

import { ScrapeHttpError } from '../../src/scrape/http/scrape-http.error';

import { FozzyAdapter } from '../../src/scrape/adapters/fozzy';
import { NormalizeService } from '../../src/scrape/normalize/normalize.service';
import { FakeHttpClient } from './fake-http-client';

import type { ProductSnapshot, StoreScrapeSpec } from '~types';

const SPEC: StoreScrapeSpec = {
  slug: 'fozzy',
  name: 'Fozzy Shop',
  baseUrl: 'https://fozzyshop.ua',
  tier: 1,
  needsBrowser: false,
  retailChain: null,
  category: null,
  delayFrom: 0,
  delayTo: 0,
};

const LISTING = 'https://fozzyshop.ua/4147-viski';

/**
 * The product page's characteristics list, trimmed from a live page captured
 * on 2026-08-10. `Вид` is the store category (always "Віскі"), `Регіон` is
 * not a country, and the barcode value carries no `_val` class — none of the
 * three may fill a snapshot field. The brand value is a link, not a span.
 */
const DETAIL = `<html><body>
<div class="product_characteristics_block">
  <h2>Характеристики</h2>
  <div class="product_characteristics_list">
    <div class="product_characteristics_item">
      <span class="product_characteristics_name">Країна</span>
      <span class="product_characteristics_val">Ірландія</span>
    </div>
    <div class="product_characteristics_item">
      <span class="product_characteristics_name">Бренд</span>
      <a href="https://fozzyshop.ua/brand/13867-tullamore-dew"
         class="product_characteristics_val product_characteristics_brand"
      >Tullamore Dew</a>
    </div>
    <div class="product_characteristics_item">
      <span class="product_characteristics_name">Вид</span>
      <span class="product_characteristics_val">Віскі</span>
    </div>
    <div class="product_characteristics_item">
      <span class="product_characteristics_name">Регіон</span>
      <span class="product_characteristics_val">Спейсайд</span>
    </div>
    <div class="product_characteristics_item">
      <span class="product_characteristics_name">Термін витримки, років</span>
      <span class="product_characteristics_val">12</span>
    </div>
    <div class="product_characteristics_item">
      <span class="product_characteristics_name">Міцність алкоголю, %</span>
      <span class="product_characteristics_val">40</span>
    </div>
    <div class="product_characteristics_item">
      <span class="product_characteristics_name">Тип</span>
      <span class="product_characteristics_val">Бленд</span>
    </div>
    <div class="product_characteristics_item">
      <span class="product_characteristics_name">Штрихкод </span>
      <span class="product_barcode_number">5016840000617</span>
    </div>
  </div>
  <div class="product_characteristics_notes">
    <span class="product_characteristics_val">Виробник залишає за собою
      право вносити зміни.</span>
  </div>
</div>
</body></html>`;

/**
 * A characteristics list whose country is the umbrella "Велика Британія",
 * which `canonicalCountry` drops so the brand/keyword pass can refine it.
 */
const DETAIL_UMBRELLA = `<html><body>
<div class="product_characteristics_item">
  <span class="product_characteristics_name">Країна</span>
  <span class="product_characteristics_val">Велика Британія</span>
</div>
</body></html>`;

/**
 * A bare snapshot for the detail tests.
 *
 * @param over - Field overrides.
 * @returns The snapshot.
 */
function snapshot(over: Partial<ProductSnapshot> = {}): ProductSnapshot {
  return {
    storeSlug: 'fozzy',
    storeSku: '605413',
    url: 'https://fozzyshop.ua/viski/605413-viski-chivas-regal-12-rokiv.html',
    name: 'Віскі Chivas Regal 12 років',
    price: 1099,
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
    ...over,
  };
}

/**
 * Builds one product card, mirroring the live markup captured on 2026-08-10:
 * the item lives in the card's `data-*` attributes, the prices in the
 * attributes of its `product_mini_prices_block`, and the bottle volume only
 * in the rendered unit label.
 *
 * @param over - Attribute overrides for the card.
 * @returns The card's HTML.
 */
function card(over: Record<string, string> = {}): string {
  const attributes: Record<string, string> = {
    id: '969304',
    name: 'Віскі High Commissioner Blended Scotch',
    priceType: 'promotion',
    price: '499',
    secondary: '799',
    unit: '1л',
    ...over,
  };
  const url = `https://fozzyshop.ua/viski/${attributes.id}-viski.html`;
  const prices = attributes.noPricesBlock === 'true' ? '' : `
    <div class="product_mini_prices_block"
         data-price-type="${attributes.priceType}"
         data-main-price="${attributes.price}"
         data-secondary-price="${attributes.secondary}"
         data-discount-quantity=""
    >
      <div class="top_line"><span class="old_price">799.00 ₴</span></div>
      <div class="bottom_line"><span class="regular_price">499.00 ₴</span></div>
    </div>`;

  return `<div class="product-mini-card product_mini js-product-card
      js-product-mini-card js-product-${attributes.id} action"
       data-product-id="${attributes.id}"
       data-unit-type="шт"
       data-product-name="${attributes.name}"
       data-price="${attributes.price}"
       data-price-type="${attributes.priceType}"
  >
    <div class="product_mini_image_block">
      <div class="product_mini_image"><a href="${url}"><img alt="x"/></a></div>
    </div>
    ${prices}
    <div class="product_mini_name">
      <a href="${url}"><span>${attributes.name}</span></a>
    </div>
    <div class="product_mini_unit"><span>${attributes.unit}</span></div>
  </div>`;
}

/**
 * Wraps cards into one listing page.
 *
 * @param cards - The page's cards.
 * @returns The page's HTML.
 */
function page(...cards: string[]): string {
  return `<html><body><div class="products_list">${cards.join('')}</div>`
    + '</body></html>';
}

/**
 * Builds an adapter over a fake transport. Listing pages are keyed by the
 * `page` query parameter; page 1 is requested without it. A page absent from
 * the map fails like the live site's 404 past the last page.
 *
 * @param pages - Page number to HTML.
 * @param detail - Optional product-page HTML, served for any other URL.
 * @returns The adapter and its fake client.
 */
function adapterOver(
  pages: Record<number, string>,
  detail?: string,
): { adapter: FozzyAdapter; http: FakeHttpClient } {
  const http = new FakeHttpClient((url, options) => {
    if (url !== LISTING) {
      if (detail === undefined) {
        throw new Error(`unexpected url ${url}`);
      }

      return { text: detail };
    }

    const html = pages[Number(options?.params?.page ?? 1)];

    /**
     * What the real client throws for a page past the end of the catalogue:
     * a typed error carrying the status, which is the only thing that tells
     * this walk's terminator apart from the store having a bad minute.
     */
    if (html === undefined) {
      throw new ScrapeHttpError(url, 404, 'HTTP 404');
    }

    return { text: html };
  });

  return {
    adapter: new FozzyAdapter(SPEC, 1, http, new NormalizeService()),
    http,
  };
}

describe('FozzyAdapter.fetchListing', () => {
  it('reads a promotion card out of its data attributes', async () => {
    const { adapter } = adapterOver({ 1: page(card()), 2: page() });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.storeSku).toBe('969304');
    expect(snap.name).toBe('Віскі High Commissioner Blended Scotch');
    expect(snap.url).toBe('https://fozzyshop.ua/viski/969304-viski.html');
    expect(snap.price).toBe(499);
    expect(snap.oldPrice).toBe(799);
    expect(snap.promo).toBe(true);
    expect(snap.volumeMl).toBe(1000);
    expect(snap.inStock).toBe(true);
  });

  it(
    'never reads the bulk price of a wholesale card as a strike-through',
    async () => {
      const { adapter } = adapterOver({
        1: page(card({
          priceType: 'wholesaleMinQuantity',
          price: '799',
          secondary: '629',
        })),
        2: page(),
      });

      const { items: [snap] } = await adapter.fetchListing();

      expect(snap.price).toBe(799);
      expect(snap.oldPrice).toBeNull();
      expect(snap.promo).toBe(false);
    },
  );

  it('reads a default-priced card without an old price', async () => {
    const { adapter } = adapterOver({
      1: page(card({ priceType: 'default', secondary: '' })),
      2: page(),
    });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.price).toBe(499);
    expect(snap.oldPrice).toBeNull();
    expect(snap.promo).toBe(false);
  });

  it(
    'falls back to the card price when the prices block is missing',
    async () => {
      const { adapter } = adapterOver({
        1: page(card({ noPricesBlock: 'true' })),
        2: page(),
      });

      const { items: [snap] } = await adapter.fetchListing();

      expect(snap.price).toBe(499);
      expect(snap.oldPrice).toBeNull();
      expect(snap.promo).toBe(true);
    },
  );

  it('parses the comma-decimal unit label into millilitres', async () => {
    const { adapter } = adapterOver({
      1: page(card({ unit: '0,7л' })),
      2: page(),
    });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.volumeMl).toBe(700);
  });

  it('drops a card without a name or a price', async () => {
    const { adapter } = adapterOver({
      1: page(
        card({ name: '' }),
        card({ id: '2', price: '', noPricesBlock: 'true' }),
      ),
    });

    const { items } = await adapter.fetchListing();

    expect(items).toEqual([]);
  });

  it(
    'paginates with ?page=N, deduplicates and stops on an empty page',
    async () => {
      const { adapter, http } = adapterOver({
        1: page(card(), card({ id: '2' })),
        2: page(card({ id: '2' }), card({ id: '3' })),
        3: page(),
      });

      const { items: snaps } = await adapter.fetchListing();

      expect(snaps.map((snap) => snap.storeSku)).toEqual(['969304', '2', '3']);
      expect(http.calls.map((call) => call.params.page)).toEqual([
        undefined,
        2,
        3,
      ]);
    },
  );

  it('ends the walk when a page past the end fails like a 404', async () => {
    const { adapter } = adapterOver({
      1: page(card(), card({ id: '2' })),
      2: page(card({ id: '3' })),
    });

    const listing = await adapter.fetchListing();

    expect(listing.items.map((snap) => snap.storeSku))
      .toEqual(['969304', '2', '3']);
    /**
     * The store publishes no total and no last-page marker, so the 404 is the
     * whole of its end-of-catalogue signal — a walk that ends on one has seen
     * everything and must be allowed to sweep.
     */
    expect(listing.complete).toBe(true);
    expect(listing.stop).toBe(ListingStop.EXHAUSTED);
  });

  /**
   * The same shape of failure, but a status that means the store is
   * struggling rather than out of pages.
   */
  it('reports an incomplete listing when a later page 503s', async () => {
    const http = new FakeHttpClient((url, options) => {
      if (Number(options?.params?.page ?? 1) === 1) {
        return { text: page(card()) };
      }

      throw new ScrapeHttpError(url, 503, 'HTTP 503');
    });
    const adapter = new FozzyAdapter(SPEC, 1, http, new NormalizeService());

    const listing = await adapter.fetchListing();

    expect(listing.items).toHaveLength(1);
    expect(listing.complete).toBe(false);
    expect(listing.stop).toBe(ListingStop.PAGE_FAILED);
  });
});

describe('FozzyAdapter.enrichDetail', () => {
  it('fills the empty fields from the characteristics list', async () => {
    const { adapter } = adapterOver({}, DETAIL);
    const snap = snapshot();

    await expect(adapter.enrichDetail(snap)).resolves.toBe(true);

    expect(snap.country).toBe('Ірландія');
    expect(snap.brand).toBe('Tullamore Dew');
    expect(snap.abv).toBe(40);
    expect(snap.ageYears).toBe(12);
    expect(snap.whiskyType).toBe('blend');
  });

  it('drops the umbrella country so the brand pass can refine it', async () => {
    const { adapter } = adapterOver({}, DETAIL_UMBRELLA);
    const snap = snapshot();

    await expect(adapter.enrichDetail(snap)).resolves.toBe(true);

    expect(snap.country).toBeNull();
  });

  it('never overwrites a field the listing already filled', async () => {
    const { adapter } = adapterOver({}, DETAIL);
    const snap = snapshot({
      brand: 'Manual',
      country: 'Шотландія',
      whiskyType: 'single malt',
      abv: 43,
      ageYears: 18,
    });

    await adapter.enrichDetail(snap);

    expect(snap.brand).toBe('Manual');
    expect(snap.country).toBe('Шотландія');
    expect(snap.whiskyType).toBe('single malt');
    expect(snap.abv).toBe(43);
    expect(snap.ageYears).toBe(18);
  });

  it('reports no detail when the page has no characteristics', async () => {
    const { adapter } = adapterOver({}, '<html><body>404</body></html>');

    const enriched = await adapter.enrichDetail(snapshot());

    expect(enriched).toBe(false);
  });

  it('skips a snapshot without a product URL', async () => {
    const { adapter, http } = adapterOver({}, DETAIL);

    const enriched = await adapter.enrichDetail(snapshot({ url: '' }));

    expect(enriched).toBe(false);
    expect(http.calls).toHaveLength(0);
  });
});
