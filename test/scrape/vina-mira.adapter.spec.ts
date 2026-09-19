import 'reflect-metadata';

import { ListingStop } from '~enums';

import { VinaMiraAdapter } from '../../src/scrape/adapters/vina-mira';
import { NormalizeService } from '../../src/scrape/normalize/normalize.service';
import { FakeHttpClient } from './fake-http-client';

import type { StoreScrapeSpec } from '~types';

const SPEC: StoreScrapeSpec = {
  slug: 'vina-mira',
  name: 'Best Wine',
  baseUrl: 'https://vina-mira.com.ua',
  tier: 1,
  needsBrowser: false,
  retailChain: null,
  category: null,
  delayFrom: 0,
  delayTo: 0,
};

const LISTING = 'https://vina-mira.com.ua/krepkie_napitki/viski/';

/**
 * Card ingredients the builder can override; null drops the block entirely.
 */
type CardParts = {
  id: string | null;
  name: string;
  href: string;
  price: string | null;
  oldPrice: string | null;
};

const CARD_DEFAULTS: CardParts = {
  id: '13731',
  name: ' Віскі Hven Hvenus Rye 0,5 л 45,6% (Швеція, ТМ Hven)',
  href: 'https://vina-mira.com.ua/viski-hven-hvenus-rye-05-l-456',
  price: '979',
  oldPrice: null,
};

/**
 * Builds one product card, trimmed from a live listing captured on
 * 2026-09-15. Three details are reproduced deliberately: the product id lives
 * only in the card root's class, the name node opens with a space, and the
 * pre-discount price sits in the image sticker panel rather than beside the
 * current price.
 *
 * @param over - Card ingredient overrides.
 * @returns The card's HTML.
 */
function card(over: Partial<CardParts> = {}): string {
  const parts = { ...CARD_DEFAULTS, ...over };
  const root = parts.id === null
    ? 'product-thumb'
    : `product-thumb product_${parts.id}`;
  const sticker = parts.oldPrice === null ? '' : `<div class="stiker_panel">
    <span class="stiker stiker_spec"><span
      class="price-old special_no_format${parts.id ?? ''}"
      >${parts.oldPrice} грн </span></span></div>`;
  const price = parts.price === null ? '' : `<div class="price"
    itemprop="offers" itemscope itemtype="http://schema.org/Offer">
    <span class="price-new"><span
      class="price_no_format${parts.id ?? ''}">${parts.price} грн </span></span>
    <meta itemprop="price" content="${parts.price}">
    <meta itemprop="priceCurrency" content="RUB"></div>`;

  return `<div class="product-layout product-list col-xs-12">
    <div class="${root}" itemprop="itemListElement" itemscope
      itemtype="http://schema.org/Product">
      <div class="image">${sticker}</div>
      <div class="caption product-info clearfix">
        <h4><a href="${parts.href}"><span
          itemprop="name">${parts.name}</span></a></h4>
        <link itemprop="url" href="${parts.href}" />
        <div class="description_options"><div class="description">
          <span class="hidden pr_quantity_${parts.id ?? ''}"></span>
        </div></div>
        <div class="product_buttons">${price}
          <div class="cart"><a><i class="fa fa-shopping-basket"><span
            class="prlistb active">Купити</span></i></a></div>
        </div>
      </div>
    </div></div>`;
}

/**
 * Wraps cards into one listing page, with the pager line the walk reconciles
 * its completeness against.
 *
 * @param cards - The page's cards.
 * @param stated - The item count the pager prints; null renders no pager.
 * @returns The page's HTML.
 */
function page(cards: string[], stated: number | null = 2): string {
  const pager = stated === null ? '' : `<div class="pagpages clearfix">
    <div class="text-right">Показано з 1 по ${cards.length} із ${stated}
    (1 сторінок)</div></div>`;

  return `<html><body><div class="row products_category">
    ${cards.join('')}</div>${pager}</body></html>`;
}

/**
 * The product page, trimmed from a live page captured on 2026-09-15. The
 * attribute set varies per product, so the list is built from whatever pairs
 * the caller names.
 *
 * @param attributes - Attribute label to value, as the page prints them.
 * @param availability - The schema.org availability URL.
 * @param description - The description tab's prose.
 * @returns The product page's HTML.
 */
function detail(
  attributes: [string, string][] = [
    ['Країна:', 'Швеція'],
    ['Обсяг:', '0,5'],
    ['Тип віскі:', 'Односолодовий'],
  ],
  availability = 'http://schema.org/InStock',
  description = 'Даний напій виробляється на віскікурні Spirit of Hven.',
): string {
  const items = attributes.map(([label, value]) =>
    `<li class="dotted-line" itemprop="additionalProperty" itemscope
      itemtype="http://schema.org/PropertyValue">
      <div class="dotted-line_left"><span class="dotted-line_title"
        itemprop="name">${label}</span></div>
      <div class="dotted-line_right" itemprop="value">${value}</div></li>`
  ).join('');

  return `<html><body>
    <meta itemprop="description" content="Замовляйте Віскі Hven за 1075.0 грн
      в магазині Best Wine. Швидка доставка по всій Україні!">
    <ul class="list-unstyled">
      <li class="dotted-line"><div class="dotted-line_left"><span
        class="dotted-line_title">Бренд:</span></div>
        <div class="dotted-line_right"><a class="manufacturer-link"
          href="/hven"><span itemprop="brand">Hven</span></a></div></li>
      <li class="dotted-line"><div class="dotted-line_right"><span
        itemprop="sku">bw056559</span></div></li>
      <li class="hidden pr_quantity">50</li>
      ${items}
    </ul>
    <div class="list-unstyled" itemprop="offers" itemscope
      itemtype="http://schema.org/Offer">
      <meta itemprop="price" content="979"/>
      <link itemprop="availability" href="${availability}"/>
      <meta itemprop="priceCurrency" content="RUB"/></div>
    <div class="tab-content"><div class="tab-pane active" id="tab-description"
      itemprop="description">${description}</div></div>
  </body></html>`;
}

/**
 * Builds the adapter over a fake client that serves listing pages by the
 * `page` query parameter, which is how OpenCart paginates; page 1 is
 * requested without it.
 *
 * @param pages - Page number to HTML.
 * @param product - Optional product-page HTML, served for any other URL.
 * @returns The adapter and its fake client.
 */
function adapterOver(
  pages: Record<number, string>,
  product?: string,
): { adapter: VinaMiraAdapter; http: FakeHttpClient } {
  const http = new FakeHttpClient((url, options) => {
    if (url !== LISTING) {
      if (product === undefined) {
        throw new Error(`unexpected url ${url}`);
      }

      return { text: product };
    }

    const html = pages[Number(options?.params?.page ?? 1)];

    if (html === undefined) {
      throw new Error(`unexpected page ${String(options?.params?.page)}`);
    }

    return { text: html };
  });

  return {
    adapter: new VinaMiraAdapter(SPEC, 1, http, new NormalizeService()),
    http,
  };
}

describe('VinaMiraAdapter.fetchListing', () => {
  it('reads the card out of the OpenCart markup', async () => {
    const { adapter } = adapterOver({ 1: page([card()], 1) });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.storeSku).toBe('13731');
    expect(snap.name).toBe(
      'Віскі Hven Hvenus Rye 0,5 л 45,6% (Швеція, ТМ Hven)',
    );
    expect(snap.url).toBe(
      'https://vina-mira.com.ua/viski-hven-hvenus-rye-05-l-456',
    );
    expect(snap.price).toBe(979);
    expect(snap.oldPrice).toBeNull();
    expect(snap.promo).toBe(false);
    expect(snap.inStock).toBe(true);
  });

  it('never reads the currency, which the markup states as RUB', async () => {
    const { adapter } = adapterOver({ 1: page([card()], 1) });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.currency).toBe('UAH');
  });

  it('reads a promotion as current price plus struck-through old', async () => {
    const { adapter } = adapterOver({
      1: page([card({ price: '979', oldPrice: '1039' })], 1),
    });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.price).toBe(979);
    expect(snap.oldPrice).toBe(1039);
    expect(snap.promo).toBe(true);
  });

  it('ignores an old price that is not above the current one', async () => {
    const { adapter } = adapterOver({
      1: page([card({ price: '979', oldPrice: '979' })], 1),
    });

    const { items: [snap] } = await adapter.fetchListing();

    expect(snap.oldPrice).toBeNull();
    expect(snap.promo).toBe(false);
  });

  it('drops a card with no product id, name, link or price', async () => {
    const { adapter } = adapterOver({
      1: page(
        [
          card({ id: null }),
          card({ id: '1', name: ' ' }),
          card({ id: '2', href: '' }),
          card({ id: '3', price: null }),
          card({ id: '4' }),
        ],
        5,
      ),
      2: page([], 5),
    });

    const { items } = await adapter.fetchListing();

    expect(items.map((snap) => snap.storeSku)).toEqual(['4']);
  });

  it('walks pages until one brings no new SKU', async () => {
    const { adapter, http } = adapterOver({
      1: page([card({ id: '1' }), card({ id: '2' })], 3),
      2: page([card({ id: '2' }), card({ id: '3' })], 3),
      3: page([], 3),
    });

    const { items, complete, stop } = await adapter.fetchListing();

    expect(items.map((snap) => snap.storeSku)).toEqual(['1', '2', '3']);
    expect(complete).toBe(true);
    expect(stop).toBe(ListingStop.COUNTED);
    expect(http.calls.map((call) => call.params)).toEqual([
      { limit: 100 },
      { limit: 100, page: 2 },
      { limit: 100, page: 3 },
    ]);
  });

  it('reconciles the stated count against the cards handed over', async () => {
    const { adapter } = adapterOver({
      1: page([card({ id: '1' }), card({ id: '2' })], 2),
      2: page([], 2),
    });

    const { complete, stop, statedItems } = await adapter.fetchListing();

    expect(statedItems).toBe(2);
    expect(complete).toBe(true);
    expect(stop).toBe(ListingStop.COUNTED);
  });

  it('reports a walk cut short by a blank page as incomplete', async () => {
    const { adapter } = adapterOver({
      1: page([card({ id: '1' }), card({ id: '2' })], 294),
      2: page([], 294),
    });

    const { items, complete, stop, statedItems } = await adapter.fetchListing();

    expect(items).toHaveLength(2);
    expect(statedItems).toBe(294);
    expect(complete).toBe(false);
    expect(stop).toBe(ListingStop.SHORT);
  });

  it(
    'counts the cards the source repeated, not the snapshots kept',
    async () => {
      const { adapter } = adapterOver({
        1: page([card({ id: '1' }), card({ id: '1' }), card({ id: '2' })], 3),
        2: page([], 3),
      });

      const { items, complete, stop } = await adapter.fetchListing();

      expect(items).toHaveLength(2);
      expect(complete).toBe(true);
      expect(stop).toBe(ListingStop.COUNTED);
    },
  );

  it('falls back to the no-new-SKU stop when no count is printed', async () => {
    const { adapter } = adapterOver({
      1: page([card({ id: '1' })], null),
      2: page([], null),
    });

    const { complete, stop, statedItems } = await adapter.fetchListing();

    expect(statedItems).toBeNull();
    expect(complete).toBe(true);
    expect(stop).toBe(ListingStop.EXHAUSTED);
  });
});

/**
 * The shop states the maker nowhere but inside the name, as
 * `(Країна, ТМ Brand)` — which the name cleaner strips. Handing the token over
 * as the stated brand is what lets whole-string brand matching resolve a
 * four-letter maker such as `Hyde` with no alias edit at all.
 */
describe('VinaMiraAdapter: the ТМ token as the stated brand', () => {
  /**
   * Reads one card's snapshot.
   *
   * @param name - The listing name the card prints.
   * @returns The snapshot.
   */
  async function listed(
    name: string,
  ): Promise<import('~types').ProductSnapshot> {
    const { adapter } = adapterOver({ 1: page([card({ name })], 1) });
    const { items: [snap] } = await adapter.fetchListing();

    return snap;
  }

  it('hands over the brand the name states', async () => {
    const snap = await listed(
      'Віскі Hyde #6 Special Reserve 0,7 л 46% (Ірландія, ТМ Hyde)',
    );

    expect(snap.brand).toBe('Hyde');
  });

  it('reads the Latin TM spelling too', async () => {
    const snap = await listed(
      'Віскі Titanic Irish Whiskey Sherry 0,7л 40% тубус '
        + '(Ірландія, TM TITANIC)',
    );

    expect(snap.brand).toBe('TITANIC');
  });

  it('states no brand when the name carries no token', async () => {
    expect((await listed('Віскі Jameson 0,7л. 40%')).brand).toBeNull();
  });
});

describe('VinaMiraAdapter.enrichDetail', () => {
  /**
   * Builds a listing snapshot and runs the detail pass over it.
   *
   * @param product - The product page's HTML.
   * @param over - Listing-card overrides, for a case about the raw name.
   * @returns The enriched snapshot and whether the pass found the list.
   */
  async function enrich(
    product: string,
    over: Partial<CardParts> = {},
  ): Promise<{ snap: import('~types').ProductSnapshot; found: boolean }> {
    const { adapter } = adapterOver({ 1: page([card(over)], 1) }, product);
    const { items: [snap] } = await adapter.fetchListing();
    const found = await adapter.enrichDetail(snap);

    return { snap, found };
  }

  it('fills type, country and volume from the attribute list', async () => {
    const { snap, found } = await enrich(detail());

    expect(found).toBe(true);
    expect(snap.whiskyType).toBe('single malt');
    expect(snap.country).toBe('Швеція');
    expect(snap.volumeMl).toBe(500);
  });

  it('reads whatever attributes the product happens to carry', async () => {
    const { snap } = await enrich(detail([
      ['Країна:', 'Ірландія'],
      ['Тип віскі:', 'Купажований'],
      ['Подарункова упаковка:', 'В коробці'],
    ]));

    expect(snap.country).toBe('Ірландія');
    expect(snap.whiskyType).toBe('blend');
    expect(snap.volumeMl).toBeNull();
  });

  it('never reads the manufacturer as a brand', async () => {
    const { snap } = await enrich(detail(), {
      name: 'Віскі Hven Hvenus Rye 0,5 л 45,6%',
    });

    expect(snap.brand).toBeNull();
  });

  it('stashes the description tab, not the marketing meta tag', async () => {
    const { snap } = await enrich(detail());

    expect(snap.rawAttrs.detailDescription)
      .toBe('Даний напій виробляється на віскікурні Spirit of Hven.');
    expect(String(snap.rawAttrs.detailDescription)).not.toContain('Best Wine');
  });

  it('flags an offer the product page states is out of stock', async () => {
    const { snap } = await enrich(
      detail(undefined, 'http://schema.org/OutOfStock'),
    );

    expect(snap.inStock).toBe(false);
  });

  it(
    'leaves the listing answer standing on an unfamiliar availability',
    async () => {
      const { snap } = await enrich(
        detail(undefined, 'http://schema.org/PreOrder'),
      );

      expect(snap.inStock).toBe(true);
    },
  );

  it('never overwrites a value the listing already carried', async () => {
    const { adapter } = adapterOver(
      { 1: page([card()], 1) },
      detail([['Країна:', 'Ірландія'], ['Обсяг:', '0,5']]),
    );
    const { items: [snap] } = await adapter.fetchListing();

    snap.country = 'Швеція';
    await adapter.enrichDetail(snap);

    expect(snap.country).toBe('Швеція');
  });

  it('fetches nothing for an out-of-stock snapshot', async () => {
    const { adapter, http } = adapterOver({ 1: page([card()], 1) }, detail());
    const { items: [snap] } = await adapter.fetchListing();

    snap.inStock = false;
    const found = await adapter.enrichDetail(snap);

    expect(found).toBe(false);
    expect(http.calls.filter((call) => call.url !== LISTING)).toHaveLength(0);
  });

  it('reports a page with no attribute list as not enriched', async () => {
    const { found } = await enrich('<html><body></body></html>');

    expect(found).toBe(false);
  });
});
