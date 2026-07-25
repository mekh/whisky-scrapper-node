import { load } from 'cheerio';

import { looksChallenged } from './clients';

import type { CheerioAPI } from 'cheerio';

import type {
  SpikeItem,
  SpikePage,
  SpikeProbe,
  SpikeProbeContext,
  SpikeProbeResult,
} from './spike.interfaces';

/**
 * One DOM node as cheerio hands it back from `toArray()`. Derived from the
 * public API on purpose: `domhandler` is a transitive dependency and must not
 * be imported directly.
 */
type SpikeNode = Parameters<CheerioAPI['contains']>[0];

const ZAKAZ_API = 'https://stores-api.zakaz.ua';
const ZAKAZ_JSON_HEADERS = { Accept: 'application/json' };
const MAUDAU_API =
  'https://backend.prod.maudau.click/v1/user/products/searches';
const OKWINE_API = 'https://product.okwine.ua/api/v1/filter/full';
const OKWINE_CATEGORY = '61c460bf1fda1bf332a33c09';
const OKWINE_CITY = '61e159f3ab2700007200435f';
const ROZETKA_LISTING = 'https://rozetka.com.ua/ua/viski/c4649130/';
const ROZETKA_TILE = 'rz-catalog-tile';

const PRICE_RE = /\d[\d\s  ]*(?:[.,]\d{1,2})?/;

/**
 * DOM extractor for Rozetka tiles, ported verbatim from the Python adapter:
 * one pass in page context returns href, title, prices and availability, so
 * no raw HTML has to travel back for parsing.
 */
const ROZETKA_EXTRACT_JS = `
() => {
  const num = s => {
    if (!s) return null;
    const m = s.replace(/[\\s ]/g, '').match(/\\d+(?:[.,]\\d+)?/);
    return m ? parseFloat(m[0].replace(',', '.')) : null;
  };
  const text = (el) => el ? el.textContent : null;
  return [...document.querySelectorAll('rz-catalog-tile')].map(t => {
    const a = t.querySelector('a[href*="/p"]');
    const titleEl = t.querySelector(
      'a.tile-title, .goods-tile__title, [data-testid="goods-tile-title"]'
    ) || a;
    return {
      href: a ? a.href : '',
      title: titleEl ? titleEl.textContent.trim() : '',
      price: num(text(t.querySelector('.price'))),
      old: num(text(t.querySelector('.old-price'))),
      inStock: !/нема\\S* в наявн/i.test(t.textContent),
    };
  }).filter(x => x.href && x.title && x.price != null);
}
`;

/**
 * Parses a price out of free-form text such as `1 614грн` or `389,00 ₴`.
 *
 * @param text - Raw price text, possibly null.
 * @returns The numeric price, or null when nothing parseable was found.
 */
const parsePrice = (text: string | null | undefined): number | null => {
  if (!text) {
    return null;
  }

  const match = PRICE_RE.exec(text);

  if (!match) {
    return null;
  }

  const raw = match[0].replace(/[\s  ]/g, '');
  const normalized = raw.includes(',') && !raw.includes('.')
    ? raw.replace(',', '.')
    : raw.replace(/,/g, '');
  const value = Number.parseFloat(normalized);

  return Number.isFinite(value) ? value : null;
};

/**
 * Narrows an unknown JSON value to a plain object.
 *
 * @param value - Value to narrow.
 * @returns The object, or null when the value is not a plain object.
 */
const asRecord = (value: unknown): Record<string, unknown> | null => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
};

/**
 * Narrows an unknown JSON value to an array.
 *
 * @param value - Value to narrow.
 * @returns The array, or an empty array when the value is not one.
 */
const asArray = (value: unknown): unknown[] => {
  return Array.isArray(value) ? value : [];
};

/**
 * Reads a numeric field from a JSON object.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns The number, or null when the field is missing or not numeric.
 */
const numberField = (
  source: Record<string, unknown>,
  key: string,
): number | null => {
  const value = source[key];

  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/**
 * Reads a string field from a JSON object, coercing numbers to strings.
 *
 * @param source - Object to read from.
 * @param key - Field name.
 * @returns The string, or an empty string when the field is unusable.
 */
const stringField = (
  source: Record<string, unknown>,
  key: string,
): string => {
  const value = source[key];

  if (typeof value === 'string') {
    return value;
  }

  return typeof value === 'number' ? String(value) : '';
};

/**
 * Parses a JSON response body, tolerating non-JSON payloads (a Cloudflare
 * interstitial served in place of the API response, for instance).
 *
 * @param body - Raw response body.
 * @returns The parsed value, or null when the body is not valid JSON.
 */
const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
};

/**
 * Walks listing pages, deduplicating by SKU, and aggregates the metrics the
 * spike reports. Stops early when a page yields nothing new, mirroring the
 * production adapters' end-of-catalog rule.
 *
 * @param ctx - Probe context providing pacing and logging.
 * @param pages - Maximum number of pages to fetch.
 * @param statuses - Status accumulator; may already hold prelude statuses.
 * @param fetchPage - Fetches and parses one page.
 * @returns Aggregated metrics for the pass.
 */
const walkPages = async (
  ctx: SpikeProbeContext,
  pages: number,
  statuses: number[],
  fetchPage: (page: number) => Promise<SpikePage>,
): Promise<SpikeProbeResult> => {
  const seen = new Set<string>();
  let challenged = false;
  let inStock = 0;
  let sample: string | null = null;
  let fetched = 0;

  for (let page = 1; page <= pages; page += 1) {
    const outcome = await fetchPage(page);

    fetched += 1;
    statuses.push(outcome.status);

    if (outcome.body !== null && looksChallenged(outcome.body)) {
      challenged = true;
    }

    let fresh = 0;

    outcome.items.forEach((item) => {
      if (item.price === null || seen.has(item.sku)) {
        return;
      }

      seen.add(item.sku);
      fresh += 1;

      if (item.inStock) {
        inStock += 1;
      }

      sample ??= `${item.name} | ${item.price} | ${item.sku}`;
    });

    ctx.log(
      `page ${page}: status=${outcome.status} parsed=${outcome.items.length} `
        + `new=${fresh} total=${seen.size}`,
    );

    if (fresh === 0) {
      break;
    }

    if (page < pages) {
      await ctx.sleep();
    }
  }

  return {
    pages: fetched,
    items: seen.size,
    inStock,
    statuses,
    challenged,
    sample,
  };
};

/**
 * Resolves the first store id of a Zakaz.ua retail chain. Prices barely
 * differ between branches, so the first match is what production uses too.
 *
 * @param ctx - Probe context.
 * @param chain - `retail_chain` value as the Zakaz API spells it.
 * @param statuses - Status accumulator to append this request's status to.
 * @returns The store id.
 * @throws {Error} When the chain has no store in the API response.
 */
const resolveZakazStore = async (
  ctx: SpikeProbeContext,
  chain: string,
  statuses: number[],
): Promise<string> => {
  const response = await ctx.get(`${ZAKAZ_API}/stores/`, {
    headers: ZAKAZ_JSON_HEADERS,
  });

  statuses.push(response.status);

  const match = asArray(parseJson(response.body))
    .map(asRecord)
    .find((store) => store !== null && store.retail_chain === chain);

  if (!match) {
    throw new Error(`No Zakaz store found for chain "${chain}"`);
  }

  return stringField(match, 'id');
};

/**
 * Maps one Zakaz.ua API product to a spike item. Prices arrive in kopecks.
 *
 * @param raw - Raw product object.
 * @returns The item, or null when the entry is unusable.
 */
const zakazItem = (raw: unknown): SpikeItem | null => {
  const product = asRecord(raw);

  if (!product) {
    return null;
  }

  const price = numberField(product, 'price');
  const sku = stringField(product, 'ean') || stringField(product, 'sku');

  if (price === null || !sku) {
    return null;
  }

  return {
    sku,
    name: stringField(product, 'title'),
    price: price / 100,
    inStock: product.in_stock !== false,
  };
};

/**
 * Builds the probe for one Zakaz.ua network. All 19 networks share this one
 * JSON API, parameterized by retail chain and category slug.
 *
 * @param slug - Store slug in our database.
 * @param chain - `retail_chain` value in the Zakaz API.
 * @param category - Category slug for this chain.
 * @returns The probe.
 */
const zakazProbe = (
  slug: string,
  chain: string,
  category: string,
): SpikeProbe => {
  return {
    slug,
    delayRange: [2, 4],
    supported: ['plain', 'impit'],
    run: async (
      ctx: SpikeProbeContext,
      pages: number,
    ): Promise<SpikeProbeResult> => {
      const statuses: number[] = [];
      const storeId = await resolveZakazStore(ctx, chain, statuses);

      ctx.log(`resolved store id ${storeId} for chain ${chain}`);

      const listing = `${ZAKAZ_API}/stores/${storeId}/categories/`
        + `${category}/products/`;

      return walkPages(ctx, pages, statuses, async (page) => {
        const response = await ctx.get(listing, {
          params: { page },
          headers: ZAKAZ_JSON_HEADERS,
        });

        const payload = asRecord(parseJson(response.body));
        const results = asArray(payload?.results);

        return {
          status: response.status,
          body: response.body,
          items: results
            .map(zakazItem)
            .filter((item): item is SpikeItem => item !== null),
        };
      });
    },
  };
};

/**
 * Maps one MauDau API product to a spike item. Only available offers count —
 * the unavailable tail is what the production adapter early-stops on.
 *
 * @param raw - Raw product object.
 * @returns The item, or null when the entry is unusable or unavailable.
 */
const maudauItem = (raw: unknown): SpikeItem | null => {
  const product = asRecord(raw);
  const offer = asRecord(product?.offer);

  if (!product || !offer) {
    return null;
  }

  const price = numberField(offer, 'price');

  if (price === null || offer.available !== true) {
    return null;
  }

  return {
    sku: stringField(product, 'id'),
    name: stringField(product, 'title'),
    price: price / 100,
    inStock: true,
  };
};

/**
 * Builds the MauDau probe (internal marketplace JSON API, no browser).
 *
 * @returns The probe.
 */
const maudauProbe = (): SpikeProbe => {
  return {
    slug: 'maudau',
    delayRange: [4, 8],
    supported: ['plain', 'impit'],
    run: (ctx: SpikeProbeContext, pages: number): Promise<SpikeProbeResult> => {
      return walkPages(ctx, pages, [], async (page) => {
        const response = await ctx.get(MAUDAU_API, {
          params: {
            category_slug: 'viski',
            page,
            per_page: 48,
            sort_field: 'popularity_index',
            sort_direction: 'DESC',
          },
          headers: {
            Accept: 'application/json',
            Origin: 'https://maudau.com.ua',
            Referer: 'https://maudau.com.ua/',
          },
        });

        return {
          status: response.status,
          body: response.body,
          items: asArray(parseJson(response.body))
            .map(maudauItem)
            .filter((item): item is SpikeItem => item !== null),
        };
      });
    },
  };
};

/**
 * Maps one OK Wine API product to a spike item. `prices.min_price` is not a
 * retail price and is deliberately ignored.
 *
 * @param raw - Raw product object.
 * @returns The item, or null when the entry is unusable.
 */
const okwineItem = (raw: unknown): SpikeItem | null => {
  const product = asRecord(raw);
  const prices = asRecord(product?.prices);

  if (!product || !prices) {
    return null;
  }

  const price = numberField(prices, 'price');
  const slug = stringField(product, 'url');
  const sku = stringField(product, 'id') || slug;

  if (price === null || price === 0 || !sku) {
    return null;
  }

  return {
    sku,
    name: stringField(product, 'name'),
    price,
    inStock: product.inStock !== false,
  };
};

/**
 * Builds the OK Wine probe (Next.js SPA fronted by a public JSON API).
 *
 * @returns The probe.
 */
const okwineProbe = (): SpikeProbe => {
  return {
    slug: 'okwine',
    delayRange: [4, 8],
    supported: ['plain', 'impit'],
    run: (ctx: SpikeProbeContext, pages: number): Promise<SpikeProbeResult> => {
      return walkPages(ctx, pages, [], async (page) => {
        const response = await ctx.get(OKWINE_API, {
          params: {
            category: OKWINE_CATEGORY,
            city: OKWINE_CITY,
            lang: 'ua',
            page,
          },
          headers: {
            Accept: 'application/json',
            Origin: 'https://okwine.ua',
          },
        });

        const payload = asRecord(parseJson(response.body));
        const block = asRecord(asRecord(payload?.data)?.productsData);

        return {
          status: response.status,
          body: response.body,
          items: asArray(block?.data)
            .map(okwineItem)
            .filter((item): item is SpikeItem => item !== null),
        };
      });
    },
  };
};

/**
 * Parses one WooCommerce listing card (WineWine markup: `ins`/`del` prices).
 *
 * @param $ - Cheerio root for the page.
 * @param node - The card node.
 * @returns The item, or null when the card is not a product tile.
 */
const winewineCard = ($: CheerioAPI, node: SpikeNode): SpikeItem | null => {
  const card = $(node);
  const title = card.find('.woocommerce-loop-product__title').first().text();
  const link = card.find('a.woocommerce-LoopProduct-link').first().attr('href')
    ?? card.find('a[href]').first().attr('href')
    ?? '';
  const sale = card.find('ins bdi').first();
  const price = sale.length > 0
    ? parsePrice(sale.text())
    : parsePrice(card.find('.woocommerce-Price-amount bdi').first().text());
  const sku = card.find('a[data-product_id]').first().attr('data-product_id')
    ?? link;

  if (!title || !sku) {
    return null;
  }

  return {
    sku,
    name: title.trim(),
    price,
    inStock: !(card.attr('class') ?? '').includes('outofstock'),
  };
};

/**
 * Parses one Wine Point card. Its price markup is custom: a sale price, or a
 * bulk-tier block whose single-bottle price lives in `.price_regular`.
 *
 * @param $ - Cheerio root for the page.
 * @param node - The card node.
 * @returns The item, or null when the card is not a product tile.
 */
const winePointCard = ($: CheerioAPI, node: SpikeNode): SpikeItem | null => {
  const card = $(node);
  const title = card.find('.woocommerce-loop-product__title').first().text();
  const link = card.find('a.woocommerce-LoopProduct-link').first().attr('href')
    ?? card.find('a[href]').first().attr('href')
    ?? '';
  const sale = card.find('.product-price-sale bdi').first();
  const tier = card
    .find('.product-price-regular-sale3-sale6 .price_regular bdi')
    .first();
  const regular = card.find('.product-price-regular bdi').first();
  const priceEl = sale.length > 0
    ? sale
    : (tier.length > 0 ? tier : regular);
  const sku = card.find('a[data-product_id]').first().attr('data-product_id')
    ?? link;

  if (!title || !sku) {
    return null;
  }

  return {
    sku,
    name: title.trim(),
    price: priceEl.length > 0 ? parsePrice(priceEl.text()) : null,
    inStock: !(card.attr('class') ?? '').includes('outofstock'),
  };
};

/**
 * Parses one Goodwine card: a Magento `<form>` carrying the product data in
 * `data-*` attributes, which is more reliable than reading rendered text.
 *
 * @param $ - Cheerio root for the page.
 * @param node - The card node.
 * @returns The item, or null when the card lacks the required attributes.
 */
const goodwineCard = ($: CheerioAPI, node: SpikeNode): SpikeItem | null => {
  const card = $(node);
  const sku = card.attr('data-sku') ?? card.attr('data-product-id') ?? '';
  const name = card.attr('data-name') ?? '';
  const price = parsePrice(card.attr('data-finalprice'))
    ?? parsePrice(card.attr('data-price'));

  if (!sku || !name) {
    return null;
  }

  return { sku, name, price, inStock: true };
};

/**
 * Builds a probe for a server-rendered HTML listing.
 *
 * @param options - Store slug, pacing, page URL builder, and card parsing.
 * @returns The probe.
 */
const htmlProbe = (options: {
  slug: string;
  delayRange: [number, number];
  supported: SpikeProbe['supported'];
  pageUrl: (page: number) => string;
  cardSelector: string;
  parseCard: ($: CheerioAPI, node: SpikeNode) => SpikeItem | null;
}): SpikeProbe => {
  return {
    slug: options.slug,
    delayRange: options.delayRange,
    supported: options.supported,
    run: (ctx: SpikeProbeContext, pages: number): Promise<SpikeProbeResult> => {
      return walkPages(ctx, pages, [], async (page) => {
        const response = await ctx.get(options.pageUrl(page));
        const $ = load(response.body);

        const items = $(options.cardSelector)
          .toArray()
          .map((node) => options.parseCard($, node))
          .filter((item): item is SpikeItem => item !== null);

        return { status: response.status, body: response.body, items };
      });
    },
  };
};

/**
 * Maps one row returned by the Rozetka DOM extractor to a spike item.
 *
 * @param raw - Raw row from `page.evaluate`.
 * @returns The item, or null when the row is unusable.
 */
const rozetkaItem = (raw: unknown): SpikeItem | null => {
  const row = asRecord(raw);

  if (!row) {
    return null;
  }

  const href = stringField(row, 'href').split('#')[0];
  const price = numberField(row, 'price');
  const match = /\/p(\d+)\//.exec(href);

  if (!href || price === null) {
    return null;
  }

  return {
    sku: match ? match[1] : href,
    name: stringField(row, 'title'),
    price,
    inStock: row.inStock !== false,
  };
};

/**
 * Builds the Rozetka probe. Browser-only: the category sits behind a
 * Cloudflare managed challenge, and every page needs a fresh context.
 *
 * @returns The probe.
 * @throws {Error} At run time when the context has no `evaluate` capability.
 */
const rozetkaProbe = (): SpikeProbe => {
  return {
    slug: 'rozetka',
    delayRange: [10, 20],
    supported: ['playwright'],
    run: (ctx: SpikeProbeContext, pages: number): Promise<SpikeProbeResult> => {
      if (!ctx.evaluate) {
        throw new Error('Rozetka requires the playwright client');
      }

      const evaluate = ctx.evaluate.bind(ctx);

      return walkPages(ctx, pages, [], async (page) => {
        const url = page === 1
          ? ROZETKA_LISTING
          : `${ROZETKA_LISTING}page=${page}/`;

        const rows = await evaluate(url, ROZETKA_EXTRACT_JS, ROZETKA_TILE);

        return {
          status: 200,
          body: null,
          items: asArray(rows)
            .map(rozetkaItem)
            .filter((item): item is SpikeItem => item !== null),
        };
      });
    },
  };
};

/**
 * Every probe the spike can run, keyed by store slug. Zakaz.ua is represented
 * by two networks: `metro` (plain `whiskey-<chain>` category) and `novus`
 * (bare `whiskey`, the historical exception worth a second data point).
 */
export const PROBES: Record<string, SpikeProbe> = {
  metro: zakazProbe('metro', 'metro', 'whiskey-metro'),
  novus: zakazProbe('novus', 'novus', 'whiskey'),
  maudau: maudauProbe(),
  okwine: okwineProbe(),
  winewine: htmlProbe({
    slug: 'winewine',
    delayRange: [4, 8],
    supported: ['plain', 'impit', 'playwright'],
    pageUrl: (page) =>
      page === 1
        ? 'https://winewine.ua/whiskey/'
        : `https://winewine.ua/whiskey/page/${page}/`,
    cardSelector: 'li.product.type-product',
    parseCard: winewineCard,
  }),
  'wine-point': htmlProbe({
    slug: 'wine-point',
    delayRange: [4, 8],
    supported: ['plain', 'impit', 'playwright'],
    pageUrl: (page) =>
      page === 1
        ? 'https://wine-point.ua/whiskey/'
        : `https://wine-point.ua/whiskey/page/${page}/`,
    cardSelector: 'div.product.type-product',
    parseCard: winePointCard,
  }),
  goodwine: htmlProbe({
    slug: 'goodwine',
    delayRange: [8, 15],
    supported: ['plain', 'impit', 'playwright'],
    pageUrl: (page) =>
      page === 1
        ? 'https://goodwine.com.ua/ua/napoi/viski/'
        : `https://goodwine.com.ua/ua/napoi/viski/?p=${page}`,
    cardSelector: 'form[data-product-id]',
    parseCard: goodwineCard,
  }),
  rozetka: rozetkaProbe(),
};
