import 'reflect-metadata';

import { AlcomagAdapter } from '../../src/scrape/adapters/alcomag';
import { NormalizeService } from '../../src/scrape/normalize/normalize.service';
import { FakeHttpClient } from './fake-http-client';

import type { ProductSnapshot, StoreScrapeSpec } from '~types';

const SPEC: StoreScrapeSpec = {
  slug: 'alcomag',
  name: 'Алкомаг',
  baseUrl: 'https://alcomag.ua',
  tier: 1,
  needsBrowser: false,
  retailChain: null,
  category: null,
  delayFrom: 0,
  delayTo: 0,
};

const LISTING = 'https://alcomag.ua/ua/krepkie-napitki/viski/';

/**
 * Card ingredients the builder can override; null drops the block entirely.
 */
type CardParts = {
  sku: string | null;
  name: string;
  href: string;
  stock: string | null;
  price: string | null;
  oldPrice: string | null;
};

const CARD_DEFAULTS: CardParts = {
  sku: '16568',
  name: 'Віскі Jack Daniels Single Barrel 0.7 л',
  href: '/ua/viski-jack-daniels-single-barrel-0-7-l/',
  stock: 'Є в наявності',
  price: '1989',
  oldPrice: null,
};

/**
 * Builds one product card, trimmed from a live listing captured on
 * 2026-08-10. The article, availability label and machine-readable prices sit
 * in the Bitrix theme's standard blocks; a promo card carries the old price
 * as a second `.price.discount` node.
 *
 * @param over - Card ingredient overrides.
 * @returns The card's HTML.
 */
function card(over: Partial<CardParts> = {}): string {
  const parts = { ...CARD_DEFAULTS, ...over };
  const stock = parts.stock === null ? '' : `<div class="item-stock ">
    <span class="icon stock"></span>
    <span class="value font_sxs">${parts.stock}</span></div>`;
  const article = parts.sku === null ? '' : `<div class="article_block"
    data-name="Арт." data-value="${parts.sku}">
    <div class="muted font_sxs">Арт.: ${parts.sku}</div></div>`;
  const price = parts.price === null ? '' : `<div
    class="price font-bold discount-exist font_mxs"
    data-currency="UAH" data-value="${parts.price}">
    <span class="values_wrapper"><span class="price_value">${parts.price}</span>
    <span class="price_currency"> грн</span></span></div>`;
  const oldPrice = parts.oldPrice === null ? '' : `<div
    class="price discount" data-currency="UAH"
    data-value="${parts.oldPrice}">
    <span class="values_wrapper font_xs muted">
    <span class="price_value">${parts.oldPrice}</span>
    <span class="price_currency"> грн</span></span></div>`;

  return `<div class="catalog_item_wrapp catalog_item item_wrap
    main_item_wrapper product_image" id="bx_3966226736_738">
    <div class="inner_wrap TYPE_1">
    <div class="item_info">
    <div class="item-title">
      <a href="${parts.href}" class="dark_link js-notice-block__title">
        <span>${parts.name}</span></a>
    </div>
    <div class="sa_block">${stock}${article}</div>
    <div class="item_info--bottom_block">
      <div class="cost prices clearfix">
        <div class="price_matrix_wrapper">
          <div class="prices-wrapper">${price}${oldPrice}</div>
        </div>
      </div>
    </div>
    </div></div></div>`;
}

/**
 * Wraps cards into one listing page.
 *
 * @param cards - The page's cards.
 * @returns The page's HTML.
 */
function page(...cards: string[]): string {
  return `<html><body><div class="catalog_block items row js_append">
    ${cards.join('')}</div></body></html>`;
}

/**
 * The product page's characteristics list plus description, trimmed from a
 * live page captured on 2026-08-10. Values may nest in a link; the volume
 * label spells its apostrophe as a backtick.
 */
const DETAIL = `<html><body><div class="char-side">
  <div class="properties list"><div class="properties__container properties">
    <div class="properties__item font_xs">
      <div class="properties__title muted js-prop-title">ШтрихКод</div>
      <div class="properties__hr muted">&mdash;</div>
      <div class="properties__value darken js-prop-value">5024576000573</div>
    </div>
    <div class="properties__item font_xs">
      <div class="properties__title muted js-prop-title">Тип</div>
      <div class="properties__hr muted">&mdash;</div>
      <div class="properties__value darken js-prop-value">
        <a href="/ua/krepkie-napitki/filter/x/apply/">Односолодовий</a></div>
    </div>
    <div class="properties__item font_xs">
      <div class="properties__title muted js-prop-title">Виробник</div>
      <div class="properties__hr muted">&mdash;</div>
      <div class="properties__value darken js-prop-value">
        <a href="/ua/krepkie-napitki/glen-grant/">Glen Grant</a></div>
    </div>
    <div class="properties__item font_xs">
      <div class="properties__title muted js-prop-title">Колір</div>
      <div class="properties__hr muted">&mdash;</div>
      <div class="properties__value darken js-prop-value">Бурштиновий</div>
    </div>
    <div class="properties__item font_xs">
      <div class="properties__title muted js-prop-title">Міцність</div>
      <div class="properties__hr muted">&mdash;</div>
      <div class="properties__value darken js-prop-value">43%</div>
    </div>
    <div class="properties__item font_xs">
      <div class="properties__title muted js-prop-title">Країна</div>
      <div class="properties__hr muted">&mdash;</div>
      <div class="properties__value darken js-prop-value">Шотландія</div>
    </div>
    <div class="properties__item font_xs">
      <div class="properties__title muted js-prop-title">Витримка</div>
      <div class="properties__hr muted">&mdash;</div>
      <div class="properties__value darken js-prop-value">12 років</div>
    </div>
    <div class="properties__item font_xs">
      <div class="properties__title muted js-prop-title">Об\`єм</div>
      <div class="properties__hr muted">&mdash;</div>
      <div class="properties__value darken js-prop-value">0.7 л</div>
    </div>
  </div></div></div>
  <div class="content detail-text-wrap">
    Аромат здатний зачарувати
    нотами деревини.
  </div></body></html>`;

/**
 * Builds a full snapshot the way the listing pass would.
 *
 * @param over - Field overrides.
 * @returns The snapshot.
 */
function snapshot(over: Partial<ProductSnapshot> = {}): ProductSnapshot {
  return {
    storeSlug: 'alcomag',
    storeSku: '16568',
    url: 'https://alcomag.ua/ua/viski-glen-grant-12-let-0-7-l/',
    name: 'Віскі Glen Grant 12 років 0.7 л',
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
 * Builds an adapter over a fake transport. Listing pages are keyed by the
 * `PAGEN_1` query parameter, which is how Bitrix paginates.
 *
 * @param pages - Page number to HTML; page 1 is requested without the param.
 * @param detail - Optional product-page HTML, served for any other URL.
 * @returns The adapter and its fake client.
 */
function adapterOver(
  pages: Record<number, string>,
  detail?: string,
): { adapter: AlcomagAdapter; http: FakeHttpClient } {
  const http = new FakeHttpClient((url, options) => {
    if (url !== LISTING) {
      if (detail === undefined) {
        throw new Error(`unexpected url ${url}`);
      }

      return { text: detail };
    }

    const html = pages[Number(options?.params?.PAGEN_1 ?? 1)];

    if (html === undefined) {
      throw new Error(
        `unexpected page ${String(options?.params?.PAGEN_1)}`,
      );
    }

    return { text: html };
  });

  return {
    adapter: new AlcomagAdapter(SPEC, 1, http, new NormalizeService()),
    http,
  };
}

describe('AlcomagAdapter.fetchListing', () => {
  it('reads the card out of the Bitrix blocks', async () => {
    const { adapter } = adapterOver({ 1: page(card()), 2: page() });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.storeSku).toBe('16568');
    expect(snap.name).toBe('Віскі Jack Daniels Single Barrel 0.7 л');
    expect(snap.url).toBe(
      'https://alcomag.ua/ua/viski-jack-daniels-single-barrel-0-7-l/',
    );
    expect(snap.price).toBe(1989);
    expect(snap.oldPrice).toBeNull();
    expect(snap.promo).toBe(false);
    expect(snap.inStock).toBe(true);
  });

  it('keeps a non-numeric article as the SKU', async () => {
    const { adapter } = adapterOver({
      1: page(card({ sku: 'МТ10' })),
      2: page(),
    });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.storeSku).toBe('МТ10');
  });

  it('reads a promotion as current price plus struck-through old', async () => {
    const { adapter } = adapterOver({
      1: page(card({ price: '1989', oldPrice: '2179' })),
      2: page(),
    });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.price).toBe(1989);
    expect(snap.oldPrice).toBe(2179);
    expect(snap.promo).toBe(true);
  });

  it('ignores an old price that is not above the current one', async () => {
    const { adapter } = adapterOver({
      1: page(card({ price: '1989', oldPrice: '1989' })),
      2: page(),
    });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.oldPrice).toBeNull();
    expect(snap.promo).toBe(false);
  });

  it(
    'keeps an out-of-stock card, placeholder price and all',
    async () => {
      const { adapter } = adapterOver({
        1: page(card({ stock: 'Немає в наявності', price: '1' })),
        2: page(),
      });

      const { items: [snap] } = await adapter.fetchListing();

      expect(snap.inStock).toBe(false);
      expect(snap.storeSku).toBe('16568');
    },
  );

  it('treats an order-only card as out of stock', async () => {
    const { adapter } = adapterOver({
      1: page(card({ stock: 'Під замовлення' })),
      2: page(),
    });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.inStock).toBe(false);
  });

  it('drops an in-stock card whose price is the placeholder', async () => {
    const { adapter } = adapterOver({
      1: page(card({ price: '1' })),
    });

    const { items } = await adapter.fetchListing();

    expect(items).toEqual([]);
  });

  it('drops a card with an unknown availability label', async () => {
    const { adapter } = adapterOver({
      1: page(card({ stock: 'Закінчується' })),
    });

    const { items } = await adapter.fetchListing();

    expect(items).toEqual([]);
  });

  it('drops a card without an article, stock or price block', async () => {
    const { adapter } = adapterOver({
      1: page(
        card({ sku: null }),
        card({ sku: '2', stock: null }),
        card({ sku: '3', price: null }),
      ),
    });

    const { items } = await adapter.fetchListing();

    expect(items).toEqual([]);
  });

  it(
    'paginates with ?PAGEN_1=N, deduplicates and stops on a repeat',
    async () => {
      const { adapter, http } = adapterOver({
        1: page(card(), card({ sku: '2' })),
        2: page(card({ sku: '2' }), card({ sku: '3' })),
        3: page(card(), card({ sku: '2' })),
      });

      const { items: snaps } = await adapter.fetchListing();

      expect(snaps.map((snap) => snap.storeSku)).toEqual([
        '16568',
        '2',
        '3',
      ]);
      expect(http.calls.map((call) => call.params.PAGEN_1)).toEqual([
        undefined,
        2,
        3,
      ]);
    },
  );
});

describe('AlcomagAdapter.enrichDetail', () => {
  it('fills the empty fields from the characteristics list', async () => {
    const { adapter } = adapterOver({}, DETAIL);
    const snap = snapshot();

    await expect(adapter.enrichDetail(snap)).resolves.toBe(true);

    expect(snap.abv).toBe(43);
    expect(snap.volumeMl).toBe(700);
    expect(snap.whiskyType).toBe('single malt');
    expect(snap.country).toBe('Шотландія');
    expect(snap.ageYears).toBe(12);
  });

  it('never reads the producer field as the brand', async () => {
    const { adapter } = adapterOver({}, DETAIL);
    const snap = snapshot();

    await adapter.enrichDetail(snap);

    expect(snap.brand).toBeNull();
  });

  it('stashes the description for the LLM flavor pass', async () => {
    const { adapter } = adapterOver({}, DETAIL);
    const snap = snapshot();

    await adapter.enrichDetail(snap);

    expect(snap.rawAttrs.description).toBe(
      'Аромат здатний зачарувати нотами деревини.',
    );
  });

  it('never overwrites a field the listing already filled', async () => {
    const { adapter } = adapterOver({}, DETAIL);
    const snap = snapshot({
      country: 'Ірландія',
      whiskyType: 'blend',
      abv: 40,
      volumeMl: 500,
      ageYears: 18,
    });

    await adapter.enrichDetail(snap);

    expect(snap.country).toBe('Ірландія');
    expect(snap.whiskyType).toBe('blend');
    expect(snap.abv).toBe(40);
    expect(snap.volumeMl).toBe(500);
    expect(snap.ageYears).toBe(18);
  });

  it('skips an out-of-stock snapshot without fetching', async () => {
    const { adapter, http } = adapterOver({}, DETAIL);
    const snap = snapshot({ inStock: false });

    await expect(adapter.enrichDetail(snap)).resolves.toBe(false);

    expect(http.calls).toEqual([]);
  });

  it('reports no detail when the page has no characteristics', async () => {
    const { adapter } = adapterOver({}, '<html><body>404</body></html>');

    const enriched = await adapter.enrichDetail(snapshot());

    expect(enriched).toBe(false);
  });
});
