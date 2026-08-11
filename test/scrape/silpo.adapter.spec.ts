import 'reflect-metadata';

import { SilpoAdapter } from '../../src/scrape/adapters/silpo';
import { NormalizeService } from '../../src/scrape/normalize/normalize.service';
import { FakeHttpClient } from './fake-http-client';

import type { ProductSnapshot, StoreScrapeSpec } from '~types';
import type {
  SilpoAttribute,
  SilpoDetail,
  SilpoProduct,
} from '../../src/scrape/adapters/silpo/silpo.interfaces';

const SPEC: StoreScrapeSpec = {
  slug: 'silpo',
  name: 'Сільпо',
  baseUrl: 'https://silpo.ua',
  tier: 1,
  needsBrowser: false,
  retailChain: null,
  category: null,
  delayFrom: 0,
  delayTo: 0,
};

const PAGE_SIZE = 100;

/**
 * Builds one API product, mirroring a captured catalog response.
 *
 * @param id - Numeric product id used as the SKU.
 * @param title - Product name.
 * @param over - Price / stock / ratio overrides.
 * @returns The raw product.
 */
function product(
  id: number,
  title: string,
  over: {
    price?: number;
    old?: number | null;
    stock?: number | null;
    ratio?: string | null;
    brand?: string | null;
  } = {},
): SilpoProduct {
  return {
    title,
    price: over.price ?? 649,
    oldPrice: 'old' in over ? over.old : null,
    slug: `viski-${id}`,
    externalProductId: id,
    stock: 'stock' in over ? over.stock : 3,
    displayRatio: 'ratio' in over ? over.ratio : '0,7л',
    brandTitle: 'brand' in over ? over.brand : 'Jameson',
  };
}

/**
 * Builds an adapter over a fake API serving the given pages.
 *
 * @param pages - Products per 1-based page number.
 * @param total - The item count the API reports.
 * @returns The adapter and the fake client it uses.
 */
function makeAdapter(
  pages: Record<number, SilpoProduct[]>,
  total: number,
): { adapter: SilpoAdapter; http: FakeHttpClient } {
  const http = new FakeHttpClient((_url, options) => {
    const page = Number(options?.params?.offset) / PAGE_SIZE + 1;

    return { body: { total, items: pages[page] ?? [] } };
  });

  const adapter = new SilpoAdapter(SPEC, 1, http, new NormalizeService());

  return { adapter, http };
}

/**
 * Collects a single-product listing and returns that snapshot.
 *
 * @param raw - The raw product to serve on page 1.
 * @returns The mapped snapshot, or undefined when the item was dropped.
 */
async function snapshotOf(
  raw: SilpoProduct,
): Promise<ProductSnapshot | undefined> {
  const { adapter } = makeAdapter({ 1: [raw] }, 1);
  const snaps = await adapter.fetchListing();

  return snaps[0];
}

/**
 * Builds one detail attribute pair.
 *
 * @param key - The attribute's machine key.
 * @param title - The value, as the API sends it (number or string).
 * @returns The attribute entry.
 */
function attr(key: string, title: string | number | null): SilpoAttribute {
  return { attribute: { key }, value: { title } };
}

/**
 * Builds a detail response, mirroring a captured product page: the attributes
 * arrive spread over groups, some of them empty.
 *
 * @param attrs - Attributes of the filled group.
 * @param descriptionRich - The HTML description, empty when absent.
 * @returns The raw detail block.
 */
function detail(attrs: SilpoAttribute[], descriptionRich = ''): SilpoDetail {
  return {
    descriptionRich,
    attributeGroups: [{ attributes: [] }, { attributes: attrs }],
  };
}

/**
 * Collects a single-product listing and returns the adapter, its snapshot and
 * the fake client, with the detail endpoint primed but not yet called.
 *
 * @param raw - The raw product to serve on page 1.
 * @param body - The detail response to serve for any product.
 * @returns The adapter, the listing snapshot and the fake client.
 */
async function prepare(
  raw: SilpoProduct,
  body: SilpoDetail,
): Promise<{
  adapter: SilpoAdapter;
  snap: ProductSnapshot;
  http: FakeHttpClient;
}> {
  const http = new FakeHttpClient((url) =>
    url.endsWith('/products')
      ? { body: { total: 1, items: [raw] } }
      : { body }
  );
  const adapter = new SilpoAdapter(SPEC, 1, http, new NormalizeService());
  const snaps = await adapter.fetchListing();

  return { adapter, snap: snaps[0], http };
}

/**
 * Runs the detail pass over a freshly collected listing snapshot.
 *
 * @param raw - The raw product to serve on page 1.
 * @param body - The detail response to serve for it.
 * @returns The enriched snapshot.
 */
async function enrich(
  raw: SilpoProduct,
  body: SilpoDetail,
): Promise<ProductSnapshot> {
  const { adapter, snap } = await prepare(raw, body);

  await adapter.enrichDetail(snap);

  return snap;
}

describe('SilpoAdapter', () => {
  it('maps the core fields', async () => {
    const snap = await snapshotOf(
      product(58113, 'Віскі Jameson', { price: 649, old: 899 }),
    );

    expect(snap).toBeDefined();
    expect(snap?.storeSlug).toBe('silpo');
    expect(snap?.storeSku).toBe('58113');
    expect(snap?.url).toBe('https://silpo.ua/product/viski-58113');
    expect(snap?.name).toBe('Віскі Jameson');
    expect(snap?.brand).toBe('Jameson');
    expect(snap?.price).toBe(649);
    expect(snap?.oldPrice).toBe(899);
    expect(snap?.promo).toBe(true);
    expect(snap?.volumeMl).toBe(700);
    expect(snap?.inStock).toBe(true);
  });

  it('ignores an old price at or below the current one', async () => {
    const snap = await snapshotOf(
      product(1, 'Віскі X', { price: 500, old: 400 }),
    );

    expect(snap?.oldPrice).toBeNull();
    expect(snap?.promo).toBe(false);
  });

  it('flags zero and null stock as out of stock', async () => {
    const zero = await snapshotOf(product(1, 'A', { stock: 0 }));
    const nulled = await snapshotOf(product(2, 'B', { stock: null }));
    const positive = await snapshotOf(product(3, 'C', { stock: 51 }));

    expect(zero?.inStock).toBe(false);
    expect(nulled?.inStock).toBe(false);
    expect(positive?.inStock).toBe(true);
  });

  it('reads the volume from the display ratio only', async () => {
    const litre = await snapshotOf(product(1, 'A', { ratio: '1л' }));
    const piece = await snapshotOf(product(2, 'B', { ratio: 'шт' }));
    const missing = await snapshotOf(product(3, 'C', { ratio: null }));

    expect(litre?.volumeMl).toBe(1000);
    expect(piece?.volumeMl).toBeNull();
    expect(missing?.volumeMl).toBeNull();
  });

  it('falls back to the slug when the numeric id is missing', async () => {
    const raw = product(7, 'Віскі Y');

    raw.externalProductId = null;

    const snap = await snapshotOf(raw);

    expect(snap?.storeSku).toBe('viski-7');
  });

  it('skips an item without a price, slug or name', async () => {
    const priceless = product(1, 'A');
    const slugless = product(2, 'B');
    const nameless = product(3, '');

    priceless.price = 0;
    slugless.slug = null;

    const { adapter } = makeAdapter(
      { 1: [priceless, slugless, nameless, product(4, 'D')] },
      4,
    );

    const snaps = await adapter.fetchListing();

    expect(snaps.map((snap) => snap.storeSku)).toEqual(['4']);
  });

  it('walks every page the total implies and deduplicates', async () => {
    const first = Array.from(
      { length: PAGE_SIZE },
      (_, i) => product(i, `Item ${i}`),
    );

    const { adapter, http } = makeAdapter(
      { 1: first, 2: [product(0, 'Item 0'), product(200, 'Item 200')] },
      PAGE_SIZE + 2,
    );

    const snaps = await adapter.fetchListing();

    expect(snaps).toHaveLength(PAGE_SIZE + 1);
    expect(http.calls.map((call) => call.params.offset)).toEqual([
      0,
      PAGE_SIZE,
    ]);
  });

  it('keeps the pages it already has when a later page fails', async () => {
    const http = new FakeHttpClient((_url, options) => {
      if (Number(options?.params?.offset) === 0) {
        return { body: { total: 300, items: [product(1, 'A')] } };
      }

      throw new Error('502');
    });
    const adapter = new SilpoAdapter(SPEC, 1, http, new NormalizeService());

    const snaps = await adapter.fetchListing();

    expect(snaps.map((snap) => snap.storeSku)).toEqual(['1']);
  });

  it('fails when the very first page fails', async () => {
    const http = new FakeHttpClient(() => {
      throw new Error('502');
    });
    const adapter = new SilpoAdapter(SPEC, 1, http, new NormalizeService());

    await expect(adapter.fetchListing()).rejects.toThrow('502');
  });
});

describe('SilpoAdapter.enrichDetail', () => {
  it('reads the ABV the listing never states', async () => {
    const numeric = await enrich(
      product(1, 'Віскі Laphroaig 12 років'),
      detail([attr('alcoholcontent', 46)]),
    );
    const fractional = await enrich(
      product(2, 'Віскі Scyfion'),
      detail([attr('alcoholcontent', 53.9)]),
    );
    const text = await enrich(
      product(3, 'Віскі X'),
      detail([attr('alcoholcontent', '40.5')]),
    );

    expect(numeric.abv).toBe(46);
    expect(fractional.abv).toBe(53.9);
    expect(text.abv).toBe(40.5);
  });

  it('requests the detail endpoint by SKU with the JSON headers', async () => {
    const { adapter, snap, http } = await prepare(
      product(58113, 'Віскі Jameson'),
      detail([attr('alcoholcontent', 40)]),
    );

    await adapter.enrichDetail(snap);

    const call = http.calls[http.calls.length - 1];

    expect(call.url).toBe(
      'https://sf-ecom-api.silpo.ua/v1/uk/branches/'
        + '00000000-0000-0000-0000-000000000000/products/58113',
    );
  });

  it('reads an exact age statement', async () => {
    const snap = await enrich(
      product(1, 'Віскі X'),
      detail([attr('strokvytrymky', '12 років')]),
    );

    expect(snap.ageYears).toBe(12);
  });

  it('reduces an age range to its lower bound', async () => {
    const snap = await enrich(
      product(1, 'Віскі X'),
      detail([attr('strokvytrymky', '3-6 років')]),
    );
    const wide = await enrich(
      product(2, 'Віскі Y'),
      detail([attr('strokvytrymky', '25-60 років')]),
    );

    expect(snap.ageYears).toBe(3);
    expect(wide.ageYears).toBe(25);
  });

  it('ignores an age stated in months', async () => {
    const snap = await enrich(
      product(1, 'Віскі X'),
      detail([attr('strokvytrymky', '18 місяців')]),
    );

    expect(snap.ageYears).toBeNull();
  });

  it('falls back to the bare age field', async () => {
    const snap = await enrich(
      product(1, 'Віскі X'),
      detail([attr('ageofcognac', '12')]),
    );

    expect(snap.ageYears).toBe(12);
  });

  it('reads the whisky type, falling back to the subspecies', async () => {
    const kind = await enrich(
      product(1, 'Віскі X'),
      detail([attr('vydviski', 'Односолодове / Single Malt')]),
    );
    const subspecies = await enrich(
      product(2, 'Віскі Y'),
      detail([attr('subspecies', 'Blended')]),
    );

    expect(kind.whiskyType).toBe('single malt');
    expect(subspecies.whiskyType).toBe('blend');
  });

  it('drops the umbrella country so the brand pass can refine it', async () => {
    const snap = await enrich(
      product(1, 'Віскі X'),
      detail([attr('country', 'Велика Британія')]),
    );

    expect(snap.country).toBeNull();
  });

  it('falls back to the bottling country past an umbrella one', async () => {
    const snap = await enrich(
      product(1, 'Віскі X'),
      detail([
        attr('country', 'Велика Британія'),
        attr('krayinarozlyvu', 'Ірландія'),
      ]),
    );

    expect(snap.country).toBe('Ірландія');
  });

  it('ignores the volume bucket range', async () => {
    const snap = await enrich(
      product(1, 'Віскі X', { ratio: null }),
      detail([attr('volume', '0,6-0,99'), attr('alcoholcontent', 40)]),
    );

    expect(snap.volumeMl).toBeNull();
    expect(snap.abv).toBe(40);
  });

  it('never overwrites a value the listing already carried', async () => {
    const { adapter, snap } = await prepare(
      product(1, 'Віскі X'),
      detail([attr('alcoholcontent', 46)]),
    );

    snap.abv = 40;

    await adapter.enrichDetail(snap);

    expect(snap.abv).toBe(40);
  });

  it('stashes the stated flavors for the keyword pass', async () => {
    const normalizer = new NormalizeService();
    const snap = await enrich(
      product(1, 'Віскі X'),
      detail([attr('smakviski', "Димний, торф'яний")]),
    );

    normalizer.normalize(snap);

    expect(snap.rawAttrs.smakviski).toBe("Димний, торф'яний");
    expect(snap.flavorTags).toEqual(['peated', 'smoky']);
  });

  it('stashes the description as text for the flavor passes', async () => {
    const snap = await enrich(
      product(1, 'Віскі X'),
      detail(
        [attr('alcoholcontent', 40)],
        '<p><strong>Медові акценти</strong></p><p>та карамель</p>',
      ),
    );

    expect(snap.rawAttrs.description).toBe('Медові акценти та карамель');
  });

  it('falls back to the plain-text description attribute', async () => {
    const snap = await enrich(
      product(1, 'Віскі X'),
      detail([attr('descriptionforwebsite', 'Класичний бленд.')]),
    );

    expect(snap.rawAttrs.description).toBe('Класичний бленд.');
  });

  it('skips an out-of-stock item without requesting anything', async () => {
    const { adapter, snap, http } = await prepare(
      product(1, 'Віскі X', { stock: 0 }),
      detail([attr('alcoholcontent', 46)]),
    );
    const before = http.calls.length;

    const enriched = await adapter.enrichDetail(snap);

    expect(enriched).toBe(false);
    expect(http.calls).toHaveLength(before);
    expect(snap.abv).toBeNull();
  });

  it('reports a product that carries no attribute at all', async () => {
    const { adapter, snap } = await prepare(
      product(1, 'Віскі X'),
      detail([attr('organiceco', null)]),
    );

    await expect(adapter.enrichDetail(snap)).resolves.toBe(false);
  });
});
