import { load } from 'cheerio';

import { ListingStop } from '~enums';
import type {
  ListingResult,
  ProductSnapshot,
  ScrapeProgressReporter,
  StoreScrapeSpec,
} from '~types';

import { isEndOfCatalog } from '../../http/http.util';
import { NormalizeService } from '../../normalize/normalize.service';
import { HttpAdapterBase } from '../scrape-adapter.base';

import { SilpoAttributeKey } from './silpo.interfaces';

import type { ScrapeHttpClient } from '../../http/http-client.interfaces';
import type {
  SilpoDetail,
  SilpoListing,
  SilpoProduct,
} from './silpo.interfaces';

const SITE = 'https://silpo.ua';

/**
 * A real branch, deliberately — a branch is the assortment *and* its stock,
 * so this constant decides what the store's availability means.
 *
 * The SPA's "no branch selected" zero UUID
 * (`00000000-0000-0000-0000-000000000000`) must never come back here: it does
 * not model stock at all. It answers `total: 1070` for this category with
 * every item at `stock > 0`, where this branch answers `total: 249` of which
 * 22 are `stock: 0` (verified live 2026-08-23). Querying it recorded ~600
 * sold-out bottles a day as available for the store's whole first fortnight.
 */
const DEFAULT_BRANCH = '1f0bae35-69aa-6bd2-82b6-9554c10c3d4a';

const API =
  `https://sf-ecom-api.silpo.ua/v1/uk/branches/${DEFAULT_BRANCH}/products`;

const JSON_HEADERS = {
  Accept: 'application/json',
  Origin: SITE,
  Referer: `${SITE}/`,
};

const CATEGORY = 'viski-4466';

const PAGE_SIZE = 100;

/**
 * Backstop against a runaway walk; the category really has ~11 pages of 100
 * (1069 items on 2026-08-09), and the reported `total` normally ends the walk.
 */
const MAX_PAGES = 40;

/**
 * Flavor attributes stashed in `rawAttrs` for the keyword flavor pass; the
 * store states them itself, so they beat guessing from the name. `smakviski`
 * is the current field and the other two are its legacy predecessors, still
 * filled on a few products.
 */
const FLAVOR_KEYS = [
  SilpoAttributeKey.FLAVOR,
  SilpoAttributeKey.TASTE,
  SilpoAttributeKey.ADD_TASTE,
];

/**
 * An age range as the store writes it (`3-6 років`), split into its lower
 * bound and whatever unit follows.
 */
const AGE_RANGE = /^\s*(\d{1,3})\s*[-–—]\s*\d{1,3}\s*(.*)$/;

/**
 * Reduces an age range to its lower bound, keeping the unit so the caller's
 * parser can still reject a non-year one: `3-6 років` becomes `3 років`, while
 * `12 років` and `18 місяців` pass through untouched.
 *
 * The rewrite is what keeps a range from being stored as its *upper* bound —
 * `NormalizeService.parseAgeValue('3-6 років')` answers 6, because its regex
 * backtracks past the first number to the one the unit actually follows. Since
 * `age` is written on insert only, a wrong value there would never be
 * corrected by a later scrape.
 *
 * @param value - The raw attribute value.
 * @returns The value with a range collapsed to its lower bound.
 */
function lowerAgeBound(value: string): string {
  const range = AGE_RANGE.exec(value);

  return range ? `${range[1]} ${range[2]}` : value;
}

/**
 * Silpo (silpo.ua) — the HTML site sits behind an aggressive Cloudflare
 * Turnstile, but its SPA loads the catalog from a separate JSON API host
 * (`sf-ecom-api.silpo.ua`) that answers plain requests, so no browser is
 * needed — the legacy tier-3 classification described the HTML host, not
 * this API. Out-of-stock items stay in the listing with `stock: 0`, which
 * feeds the `inStock` flag directly instead of relying on the persist sweep.
 *
 * The listing carries no strength, type, age or flavor at all — which is why
 * the store accumulated 778 null `abv` rows out of 831 before this adapter
 * supported detail pages. All of it lives on the per-product endpoint, in an
 * `attributeGroups` list, so the adapter enriches from there. Its `volume`
 * attribute is deliberately *not* read: it is a bucket range (`0,6-0,99`),
 * while the listing's `displayRatio` already states the exact pack size.
 */
export class SilpoAdapter extends HttpAdapterBase {
  /**
   * Flattens an HTML fragment to plain text, inserting a separator at every
   * element boundary.
   *
   * Cheerio's own `.text()` concatenates the raw text nodes, so the paragraph
   * break in `<p>Тандем ніжності</p><p>Аромат …</p>` disappears and the two
   * sentences come back glued into `витонченостіАромат` — a made-up word in
   * the middle of the text the flavor model is asked to read. Separating on
   * every element rather than a hardcoded block-tag list also survives a
   * nested wrapper; the surplus space inside inline markup collapses away
   * with the rest of the whitespace.
   *
   * @param html - The HTML fragment.
   * @returns The fragment's text, whitespace not yet collapsed.
   */
  private static htmlToText(html: string): string {
    const $ = load(html);

    $('body *').after(' ');

    return $('body').text();
  }

  public readonly supportsDetail = true;

  private readonly normalizer: NormalizeService;

  public constructor(
    spec: StoreScrapeSpec,
    delayMultiplier: number,
    http: ScrapeHttpClient,
    normalizer: NormalizeService,
    reporter?: ScrapeProgressReporter,
  ) {
    super(spec, delayMultiplier, http, reporter);

    this.normalizer = normalizer;
  }

  /**
   * Walks the whisky category page by page, up to the page count derived
   * from the total the API reports.
   *
   * The API states an exact item count on every page, so this walk is one of
   * the few that can prove completeness outright rather than infer it from
   * running out of pages — which matters, because the category legitimately
   * collapsed from 1070 items to 249 in a day and the run has to be trusted
   * enough to act on that.
   *
   * @returns The store's whisky listing, out-of-stock items included, and
   * whether it is the whole listing.
   * @throws {ScrapeHttpError} When the very first page cannot be fetched.
   */
  public async fetchListing(): Promise<ListingResult> {
    const snaps: ProductSnapshot[] = [];
    const seen = new Set<string>();
    let statedItems: number | null = null;
    let received = 0;
    let totalPages: number | null = null;
    let page = 1;

    while (page <= Math.min(totalPages ?? MAX_PAGES, MAX_PAGES)) {
      let listing: SilpoListing;

      try {
        listing = await this.fetchPage(page);
      } catch (error) {
        if (snaps.length === 0) {
          throw error;
        }

        return this.listing(
          snaps,
          isEndOfCatalog(error)
            ? ListingStop.EXHAUSTED
            : ListingStop.PAGE_FAILED,
          statedItems,
          received,
        );
      }

      statedItems ??= this.readTotalItems(listing);
      totalPages ??= this.readTotalPages(listing);

      const items = listing.items ?? [];

      received += items.length;

      const fresh = this.freshSnapshots(
        items,
        seen,
        (product) => this.toSnapshot(product),
      );

      fresh.forEach((snap) => seen.add(snap.storeSku));
      snaps.push(...fresh);
      this.emit({
        kind: 'page',
        page,
        added: fresh.length,
        total: snaps.length,
      });

      if (fresh.length === 0) {
        return this.listing(
          snaps,
          ListingStop.EXHAUSTED,
          statedItems,
          received,
        );
      }

      page += 1;
      await this.sleep();
    }

    /**
     * The loop bound is the lower of the declared page count and the backstop,
     * so falling out of it means one of two very different things: every
     * declared page was consumed, or the backstop cut the walk short.
     */
    const hitPageCap = totalPages === null || page <= totalPages;

    return this.listing(
      snaps,
      hitPageCap ? ListingStop.PAGE_CAP : ListingStop.EXHAUSTED,
      statedItems,
      received,
    );
  }

  /**
   * Fills ABV / age / type / country from the product's attribute list and
   * stashes its stated flavor and description for the flavor passes.
   * Out-of-stock snapshots are skipped — only their SKU is persisted, so the
   * request would be pure politeness-delay spend.
   *
   * @param snap - The snapshot to enrich; mutated in place, per the adapter
   *   contract.
   * @returns True when the product carried any attribute at all.
   */
  public async enrichDetail(snap: ProductSnapshot): Promise<boolean> {
    if (!snap.inStock) {
      return false;
    }

    const detail = await this.fetchDetail(snap.storeSku);
    const attrs = this.attributeMap(detail);

    if (attrs.size === 0) {
      return false;
    }

    this.applyFields(attrs, snap);
    this.applyFlavors(attrs, snap);
    this.applyDescription(detail, attrs, snap);

    return true;
  }

  /**
   * Fetches one product's detail response. The same JSON headers the listing
   * sends are repeated here: the API host sits behind Cloudflare, and this is
   * the header set verified against it.
   *
   * @param sku - The store SKU, i.e. the numeric product id or, on the
   *   fallback path, the URL slug — the endpoint accepts either.
   * @returns The product's detail block.
   */
  private async fetchDetail(sku: string): Promise<SilpoDetail> {
    const response = await this.http.get(`${API}/${sku}`, {
      headers: JSON_HEADERS,
    });

    return response.json<SilpoDetail>();
  }

  /**
   * Flattens every attribute group into one key/value map. The grouping
   * (`generalInfo`, `nutrient`, ...) carries nothing the adapter needs, and
   * numeric values are coerced to text so one parser handles both wire types.
   *
   * @param detail - The product's detail block.
   * @returns Attribute key to trimmed value, empty values dropped.
   */
  private attributeMap(detail: SilpoDetail): Map<string, string> {
    const attrs = new Map<string, string>();

    (detail.attributeGroups ?? []).forEach((group) => {
      (group.attributes ?? []).forEach((entry) => {
        const key = entry.attribute?.key ?? '';
        const raw = entry.value?.title;
        const value = raw === null || raw === undefined
          ? ''
          : String(raw).trim();

        if (key !== '' && value !== '' && !attrs.has(key)) {
          attrs.set(key, value);
        }
      });
    });

    return attrs;
  }

  /**
   * Fills the snapshot's still-null spec fields from the attribute map. Every
   * assignment is `??=`, so a listing value or a manual edit always wins.
   *
   * @param attrs - The product's flattened attributes.
   * @param snap - The snapshot to fill; mutated in place.
   */
  private applyFields(
    attrs: Map<string, string>,
    snap: ProductSnapshot,
  ): void {
    snap.abv ??= this.firstValue(
      attrs,
      [SilpoAttributeKey.ABV],
      (value) => this.normalizer.parseAbvValue(value),
    );
    snap.ageYears ??= this.firstValue(
      attrs,
      [SilpoAttributeKey.AGE, SilpoAttributeKey.AGE_ALT],
      (value) => this.normalizer.parseAgeValue(lowerAgeBound(value)),
    );
    snap.whiskyType ??= this.firstValue(
      attrs,
      [SilpoAttributeKey.WHISKY_TYPE, SilpoAttributeKey.SUBSPECIES],
      (value) => this.normalizer.extractType(value),
    );
    snap.country ??= this.firstValue(
      attrs,
      [SilpoAttributeKey.COUNTRY, SilpoAttributeKey.BOTTLING_COUNTRY],
      (value) => this.normalizer.canonicalCountry(value),
    );
  }

  /**
   * Reads the first of several attribute keys that yields a value, parsing
   * each candidate on its own.
   *
   * Parsing per source rather than picking a raw value first is load-bearing:
   * `country` is filled on nearly every product but usually holds the umbrella
   * `Велика Британія`, which `canonicalCountry` drops so the brand pass can
   * refine it to `Шотландія`. A raw `a ?? b` chain would consume the primary
   * key and never consult the fallback.
   *
   * @param attrs - The product's flattened attributes.
   * @param keys - Candidate keys, most specific first.
   * @param parse - Parser applied to each present candidate.
   * @returns The first non-null parse result, or null.
   */
  private firstValue<T>(
    attrs: Map<string, string>,
    keys: SilpoAttributeKey[],
    parse: (value: string) => T | null,
  ): T | null {
    const parsed = keys
      .map((key) => attrs.get(key))
      .filter((value): value is string => value !== undefined)
      .map((value) => parse(value));

    return parsed.find((value) => value !== null) ?? null;
  }

  /**
   * Stashes the store's own flavor attributes into `rawAttrs`, where the
   * keyword flavor pass reads them. They are not mapped to tags here — the
   * shared `FLAVOR_KEYWORDS` vocabulary owns that decision.
   *
   * Note that its peat words no longer produce a tag: a value like
   * `Димний, торф'яний` used to yield `smoky` and `peated`, and now yields
   * neither, because peat comes from the knowledge base alone. The text is
   * still worth stashing — it feeds the other thirteen tags and the flavour
   * prompt's grounding.
   *
   * @param attrs - The product's flattened attributes.
   * @param snap - The snapshot to fill; mutated in place.
   */
  private applyFlavors(
    attrs: Map<string, string>,
    snap: ProductSnapshot,
  ): void {
    FLAVOR_KEYS.forEach((key) => {
      const value = attrs.get(key);

      if (value !== undefined) {
        snap.rawAttrs[key] = value;
      }
    });
  }

  /**
   * Stashes the product's description into `rawAttrs`, where the LLM flavor
   * pass looks for grounding text. The prose is never parsed for fields (a
   * description's "N років" is brand history, not maturation). The response's
   * top-level `description` is ignored — it holds the placeholder
   * `'no desc yet'` on every product.
   *
   * @param detail - The product's detail block.
   * @param attrs - The product's flattened attributes.
   * @param snap - The snapshot to fill; mutated in place.
   */
  private applyDescription(
    detail: SilpoDetail,
    attrs: Map<string, string>,
    snap: ProductSnapshot,
  ): void {
    const rich = detail.descriptionRich ?? '';
    const text = rich === ''
      ? attrs.get(SilpoAttributeKey.DESCRIPTION) ?? ''
      : SilpoAdapter.htmlToText(rich);

    const description = text.replace(/\s+/g, ' ').trim();

    if (description !== '' && snap.rawAttrs.description === undefined) {
      snap.rawAttrs.description = description;
    }
  }

  /**
   * Fetches one listing page.
   *
   * @param page - 1-based page number, translated to a `limit`/`offset` pair.
   * @returns The page's listing block.
   */
  private async fetchPage(page: number): Promise<SilpoListing> {
    const response = await this.http.get(API, {
      params: {
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        category: CATEGORY,
      },
      headers: JSON_HEADERS,
    });

    return response.json<SilpoListing>();
  }

  /**
   * Reads the item count the API states for the category.
   *
   * @param listing - Any listing page.
   * @returns The item count, or null when it is missing or unusable.
   */
  private readTotalItems(listing: SilpoListing): number | null {
    const total = listing.total;

    return typeof total === 'number' && total > 0 ? total : null;
  }

  /**
   * Derives the page count from the total item count the API reports.
   *
   * @param listing - Any listing page.
   * @returns The page count, or null when the total is missing or unusable.
   */
  private readTotalPages(listing: SilpoListing): number | null {
    const total = this.readTotalItems(listing);

    return total === null ? null : Math.ceil(total / PAGE_SIZE);
  }

  /**
   * Maps one API product to a snapshot.
   *
   * @param product - The raw product.
   * @returns The snapshot, or null when the item lacks a slug, name or price.
   */
  private toSnapshot(product: SilpoProduct): ProductSnapshot | null {
    const price = product.price;
    const slug = product.slug ?? '';
    const name = product.title ?? '';

    if (!price || slug === '' || name === '') {
      return null;
    }

    const sku = product.externalProductId;
    const oldPrice = product.oldPrice;
    const discounted = Boolean(oldPrice && oldPrice > price);

    return this.makeSnapshot({
      storeSku: sku === null || sku === undefined ? slug : String(sku),
      url: `${SITE}/product/${slug}`,
      name,
      brand: product.brandTitle ?? null,
      price,
      oldPrice: discounted ? Number(oldPrice) : null,
      inStock: (product.stock ?? 0) > 0,
      promo: discounted,
      /**
       * The pack size the site displays beats parsing the name, which
       * carries no volume at all here.
       */
      volumeMl: this.normalizer.parseVolumeValue(product.displayRatio),
      rawAttrs: { category: CATEGORY },
    });
  }
}
