import 'reflect-metadata';

import { ListingStop } from '~enums';

import { WinebutikAdapter } from '../../src/scrape/adapters/winebutik';
import { ScrapeHttpError } from '../../src/scrape/http/scrape-http.error';
import { NormalizeService } from '../../src/scrape/normalize/normalize.service';
import { FakeHttpClient } from './fake-http-client';

import type { ProductSnapshot, StoreScrapeSpec } from '~types';

const SPEC: StoreScrapeSpec = {
  slug: 'winebutik',
  name: 'Винний Бутик',
  baseUrl: 'https://winebutik.com.ua',
  tier: 1,
  needsBrowser: false,
  retailChain: null,
  category: null,
  delayFrom: 0,
  delayTo: 0,
};

const LISTING = 'https://winebutik.com.ua/drinks/category/whiskey';

/**
 * The fields one fake card is built from.
 */
interface CardInput {
  /**
   * Commerce product id carried by the add-to-cart form — the SKU. Null
   * renders the form without the input.
   */
  productId?: string | null;

  /**
   * Product name, inserted verbatim (the live site entity-encodes
   * apostrophes).
   */
  name?: string;

  /**
   * Root-relative product link.
   */
  href?: string;

  /**
   * Rendered price text (`500 ₴`). Null renders no price block at all,
   * which is how the live site renders a sold-out card.
   */
  priceText?: string | null;

  /**
   * Pack size as the bare litre number the size field holds (`0.75`).
   */
  size?: string;

  /**
   * Strength field text (`40.0%`).
   */
  alcohol?: string;

  /**
   * Availability label (`Є в наявності` / `Запитати` /
   * `У найближчому надходженні`).
   */
  availability?: string;

  /**
   * Short card description (category and origin prose).
   */
  description?: string;
}

/**
 * Builds one product card the way the live site renders it on 2026-08-26:
 * the Drupal field wrappers for size / strength / availability, the price
 * div only on purchasable cards, and the add-to-cart form whose hidden
 * `product_id` input carries the SKU.
 *
 * @param input - The card's fields.
 * @returns The card's HTML.
 */
function card(input: CardInput = {}): string {
  const {
    productId = '30318',
    name = 'Dewar&#039;s White Label 0.75L',
    href = '/dewars-white-label-075',
    priceText = '500 &#8372;',
    size = '0.75',
    alcohol = '40.0%',
    availability = 'Є в наявності',
    description = "Купажований шотландський віскі Дюар'с Біла етикетка",
  } = input;
  const price = priceText === null
    ? ''
    : `<div class="product-item-price"><div class="price">
        ${priceText} </div></div>`;
  const skuInput = productId === null
    ? ''
    : `<input type="hidden" name="product_id" value="${productId}"/>`;

  return `<li class="col-sm-12 product-item product-item-opt-0">
    <div class="product-item-info">
      <div class="product-item-photo">
        <a href="${href}" class="product-item-img"><img alt="x"/></a>
      </div>
      <div class="product-item-detail">
        <h2 class="product-item-name"><a href="${href}">${name}</a></h2>
        <div class="product-item-des">
          <div class="field field-name-body field-type-text-with-summary
            field-label-hidden"><div class="field-items"><div
            class="field-item even"><p>${description}</p>
          </div></div></div>
        </div>
        <div class="flex">
          <div class="product-item-size"><div class="flex">
            <div class="commerce-product-field
              commerce-product-field-field-size field-field-size"><div
              class="field field-name-field-size
              field-type-taxonomy-term-reference field-label-hidden"><div
              class="field-items"><div class="field-item even">${size}</div>
              </div></div></div>L&nbsp;·&nbsp;<div class="field
              field-name-field-alcohol field-type-text field-label-hidden">
              <div class="field-items"><div class="field-item even">
              ${alcohol}</div></div></div>
          </div></div>
          ${price}
        </div>
        <div class="commerce-product-field
          commerce-product-field-field-available field-field-available"><div
          class="field field-name-field-available
          field-type-taxonomy-term-reference field-label-hidden"><div
          class="field-items"><div class="field-item even">${availability}
          </div></div></div></div>
        <div class="product-item-actions">
          <form class="commerce-add-to-cart" action="/drinks/category/whiskey"
            method="post"><div>
            ${skuInput}
            <input type="hidden" name="quantity" value="1"/>
            <button type="submit" class="btn btn-success">
              Додати в кошик</button>
          </div></form>
        </div>
      </div>
    </div>
  </li>`;
}

/**
 * Wraps cards into one listing page.
 *
 * @param cards - The page's cards.
 * @returns The page's HTML.
 */
function page(...cards: string[]): string {
  return `<html><body><div class="view-content">
    <div class="products products-list"><ul class="product-items row">
    ${cards.join('')}
    </ul></div></div></body></html>`;
}

/**
 * Builds a product page holding the "Факти" block and the description body.
 *
 * @param over - Field overrides; null omits the field entirely.
 * @returns The product page's HTML.
 */
function detailPage(over: {
  linkType?: string | null;
  linkClass?: string | null;
  region?: string[] | null;
  alcohol?: string | null;
  size?: string | null;
  body?: string | null;
  producer?: string | null;
} = {}): string {
  const {
    linkType = 'Купажований',
    linkClass = 'Blended Scotch Whisky',
    region = ['Шотландія', 'Спейсайд'],
    alcohol = '40.0%',
    size = '0.75',
    body = 'Віскі витриманий у бочках з-під хересу.',
    producer = 'Bardinet',
  } = over;
  const regionLinks = (region ?? [])
    .map((name) => `<a href="/drinks/region/x">${name}</a>`)
    .join(', ');
  const parts = [
    producer === null ? '' : `<div class="field field-name-field-link-producer
      field-type-text field-label-inline"><div class="field-items"><div
      class="field-item even"><a href="/producer/x">${producer}</a>
      </div></div></div>`,
    linkType === null ? '' : `<div class="field field-name-field-link-type
      field-type-text field-label-inline"><div class="field-items"><div
      class="field-item even"><div><a href="/drinks/type/x">${linkType}</a>
      </div></div></div></div>`,
    linkClass === null ? '' : `<div class="field field-name-field-link-class
      field-type-text field-label-inline"><div class="field-items"><div
      class="field-item even">${linkClass}</div></div></div>`,
    region === null ? '' : `<div class="field field-name-field-link-region
      field-type-text field-label-inline"><div class="field-items"><div
      class="field-item even"><div>${regionLinks}</div></div></div></div>`,
    alcohol === null ? '' : `<div class="field field-name-field-alcohol
      field-type-text field-label-inline"><div class="field-items"><div
      class="field-item even">${alcohol}</div></div></div>`,
    size === null ? '' : `<div class="commerce-product-field
      field-field-size"><div class="field field-name-field-size
      field-type-taxonomy-term-reference"><div class="field-items"><div
      class="field-item even">${size}</div></div></div></div>`,
  ];
  const bodyBlock = body === null
    ? ''
    : `<div class="field field-name-body field-type-text-with-summary
      field-label-hidden"><div class="field-items"><div class="field-item
      even"><p>${body}</p></div></div></div>`;

  return `<html><body>
    <div class="product-overview"><h2>Факти</h2>${parts.join('')}</div>
    ${bodyBlock}
  </body></html>`;
}

/**
 * Builds an adapter over a fake transport. Listing pages are keyed by the
 * store's zero-based `page` query parameter (the first page is requested
 * without it); a page absent from the map fails like the live site's 404
 * past the last one. Any non-listing URL is served the detail page.
 *
 * @param pages - Zero-based page number to HTML.
 * @param detail - Product-page HTML for detail requests.
 * @returns The adapter and its fake client.
 */
function adapterOver(
  pages: Record<number, string>,
  detail?: string,
): { adapter: WinebutikAdapter; http: FakeHttpClient } {
  const http = new FakeHttpClient((url, options) => {
    if (url === LISTING) {
      const html = pages[Number(options?.params?.page ?? 0)];

      if (html === undefined) {
        throw new ScrapeHttpError(url, 404, 'HTTP 404');
      }

      return { text: html };
    }

    if (detail !== undefined) {
      return { text: detail };
    }

    throw new Error(`unexpected url ${url}`);
  });

  return {
    adapter: new WinebutikAdapter(SPEC, 1, http, new NormalizeService()),
    http,
  };
}

/**
 * Builds an in-stock snapshot the way the listing produces it.
 *
 * @param over - Field overrides.
 * @returns The snapshot.
 */
function snapshot(over: Partial<ProductSnapshot> = {}): ProductSnapshot {
  return {
    storeSlug: 'winebutik',
    storeSku: '30318',
    url: 'https://winebutik.com.ua/dewars-white-label-075',
    name: "Dewar's White Label 0.75L",
    price: 500,
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
    ...over,
  };
}

describe('WinebutikAdapter.fetchListing', () => {
  it('reads a card off the listing markup', async () => {
    const { adapter } = adapterOver({ 0: page(card()), 1: page() });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.storeSku).toBe('30318');
    expect(snap.name).toBe("Dewar's White Label 0.75L");
    expect(snap.url).toBe('https://winebutik.com.ua/dewars-white-label-075');
    expect(snap.price).toBe(500);
    expect(snap.oldPrice).toBeNull();
    expect(snap.promo).toBe(false);
    expect(snap.inStock).toBe(true);
    expect(snap.volumeMl).toBe(750);
    expect(snap.abv).toBe(40);
    expect(snap.rawAttrs.description).toBe(
      "Купажований шотландський віскі Дюар'с Біла етикетка",
    );
  });

  it('parses a thousands-separated price', async () => {
    const { adapter } = adapterOver({
      0: page(card({ priceText: '150 000 &#8372;' })),
      1: page(),
    });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.price).toBe(150000);
  });

  it('stops the walk on the page where the sold-out tail begins', async () => {
    const { adapter, http } = adapterOver({
      0: page(card(), card({ productId: '2', href: '/b' })),
      1: page(
        card({ productId: '3', href: '/c' }),
        card({
          productId: '4',
          href: '/d',
          priceText: null,
          availability: 'Запитати',
        }),
        card({
          productId: '5',
          href: '/e',
          priceText: null,
          availability: 'У найближчому надходженні',
        }),
      ),
      2: page(card({ productId: '6', href: '/f' })),
    });

    const listing = await adapter.fetchListing();

    /**
     * The in-stock prefix of the boundary page is kept, the sold-out cards
     * are not collected, and the page after the boundary is never fetched —
     * the tail is this source's end-of-listing marker, so the walk is
     * complete and the run may sweep.
     */
    expect(listing.items.map((snap) => snap.storeSku))
      .toEqual(['30318', '2', '3']);
    expect(listing.complete).toBe(true);
    expect(listing.stop).toBe(ListingStop.EXHAUSTED);
    expect(http.calls.map((call) => call.params.page)).toEqual([
      undefined,
      1,
    ]);
  });

  it(
    'drops an unknown availability label without ending the walk',
    async () => {
      const { adapter, http } = adapterOver({
        0: page(
          card(),
          card({ productId: '2', href: '/b', availability: 'Очікуйте' }),
        ),
        1: page(card({ productId: '3', href: '/c' })),
        2: page(),
      });

      const listing = await adapter.fetchListing();

      /**
       * An unknown label is neither purchasable nor a proven tail: the card
       * is dropped, but the walk goes on — ending on it would let a
       * relabeled store claim a completeness it did not prove.
       */
      expect(listing.items.map((snap) => snap.storeSku))
        .toEqual(['30318', '3']);
      expect(listing.complete).toBe(true);
      expect(http.calls.map((call) => call.params.page)).toEqual([
        undefined,
        1,
        2,
      ]);
    },
  );

  it('drops a card without a SKU or a price', async () => {
    const { adapter } = adapterOver({
      0: page(
        card({ productId: null }),
        card({ productId: '2', href: '/b', priceText: null }),
        card({ productId: '3', href: '/c' }),
      ),
      1: page(),
    });

    const { items } = await adapter.fetchListing();

    expect(items.map((snap) => snap.storeSku)).toEqual(['3']);
  });

  it(
    'paginates zero-based, deduplicates and stops on a repeat page',
    async () => {
      const { adapter, http } = adapterOver({
        0: page(card(), card({ productId: '2', href: '/b' })),
        1: page(
          card({ productId: '2', href: '/b' }),
          card({ productId: '3', href: '/c' }),
        ),
        2: page(card(), card({ productId: '3', href: '/c' })),
      });

      const { items: snaps } = await adapter.fetchListing();

      expect(snaps.map((snap) => snap.storeSku)).toEqual(['30318', '2', '3']);
      expect(http.calls.map((call) => call.params.page)).toEqual([
        undefined,
        1,
        2,
      ]);
    },
  );

  it('ends the walk when a page past the end fails like a 404', async () => {
    const { adapter } = adapterOver({
      0: page(card()),
      1: page(card({ productId: '2', href: '/b' })),
    });

    const listing = await adapter.fetchListing();

    /**
     * The whole catalog being purchasable is the one case the tail marker
     * never fires for — the pager's 404 past the last page is then the
     * end-of-listing signal, exactly like the other paged HTML stores.
     */
    expect(listing.items).toHaveLength(2);
    expect(listing.complete).toBe(true);
    expect(listing.stop).toBe(ListingStop.EXHAUSTED);
  });

  it('reports an incomplete listing when a later page 503s', async () => {
    const http = new FakeHttpClient((url, options) => {
      if (Number(options?.params?.page ?? 0) === 0) {
        return { text: page(card()) };
      }

      throw new ScrapeHttpError(url, 503, 'HTTP 503');
    });
    const adapter = new WinebutikAdapter(SPEC, 1, http, new NormalizeService());

    const listing = await adapter.fetchListing();

    expect(listing.items).toHaveLength(1);
    expect(listing.complete).toBe(false);
    expect(listing.stop).toBe(ListingStop.PAGE_FAILED);
  });
});

describe('WinebutikAdapter.enrichDetail', () => {
  it('fills type, country, ABV and volume from the facts block', async () => {
    const { adapter } = adapterOver({}, detailPage());
    const snap = snapshot();

    const enriched = await adapter.enrichDetail(snap);

    expect(enriched).toBe(true);
    expect(snap.whiskyType).toBe('blend');
    expect(snap.country).toBe('Шотландія');
    expect(snap.abv).toBe(40);
    expect(snap.volumeMl).toBe(750);
    expect(snap.rawAttrs.detailDescription).toBe(
      'Віскі витриманий у бочках з-під хересу.',
    );
  });

  it(
    'falls back to the classification when the type is unmappable',
    async () => {
      const { adapter } = adapterOver(
        {},
        detailPage({
          linkType: 'Особливий',
          linkClass: 'Single Grain Scotch Whisky',
        }),
      );
      const snap = snapshot();

      await adapter.enrichDetail(snap);

      expect(snap.whiskyType).toBe('grain');
    },
  );

  it('drops the umbrella country so the brand pass can refine it', async () => {
    const { adapter } = adapterOver(
      {},
      detailPage({
        region: ['Велика Британія'],
      }),
    );
    const snap = snapshot();

    await adapter.enrichDetail(snap);

    expect(snap.country).toBeNull();
  });

  it('never overwrites what the listing already provided', async () => {
    const { adapter } = adapterOver({}, detailPage());
    const snap = snapshot({ abv: 43, volumeMl: 1000 });

    await adapter.enrichDetail(snap);

    expect(snap.abv).toBe(43);
    expect(snap.volumeMl).toBe(1000);
  });

  it('never reads the producer as the brand', async () => {
    const { adapter } = adapterOver({}, detailPage({ producer: 'Bardinet' }));
    const snap = snapshot();

    await adapter.enrichDetail(snap);

    expect(snap.brand).toBeNull();
  });

  it('skips an out-of-stock snapshot without fetching', async () => {
    const { adapter, http } = adapterOver({}, detailPage());
    const snap = snapshot({ inStock: false });

    const enriched = await adapter.enrichDetail(snap);

    expect(enriched).toBe(false);
    expect(http.calls).toHaveLength(0);
  });

  it('answers false when the page shows no facts block', async () => {
    const { adapter } = adapterOver(
      {},
      '<html><body><p>nothing here</p></body></html>',
    );
    const snap = snapshot();

    const enriched = await adapter.enrichDetail(snap);

    expect(enriched).toBe(false);
  });
});
