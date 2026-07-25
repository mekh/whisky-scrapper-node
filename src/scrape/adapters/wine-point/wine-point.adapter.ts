import type {
  ProductSnapshot,
  ScrapeProgressReporter,
  StoreScrapeSpec,
} from '~types';

import { firstText } from '../../html/html.util';
import { parsePrice } from '../../http/parse-price.util';
import { NormalizeService } from '../../normalize/normalize.service';
import { WooCommerceAdapterBase } from '../woocommerce-adapter.base';

import type { CheerioAPI } from 'cheerio';
import type { HtmlNode } from '../../html/html.interfaces';
import type { ScrapeHttpClient } from '../../http/http-client.interfaces';
import type { WooCommercePrices } from '../woocommerce-adapter.interfaces';

const LISTING = 'https://wine-point.ua/whiskey/';

const CARD_SELECTOR = 'div.product.type-product';

const SALE_SELECTOR = '.product-price-sale bdi';

/**
 * The struck-through previous price of a promoted item. The sibling `<mark>`
 * holds the discount amount, not a price, so it must not be matched.
 */
const SALE_OLD_SELECTOR = '.product-price-regular-discount s bdi';

/**
 * Bulk-tier block: `.price_regular` is the single-bottle price, while
 * `price_sale3` / `price_sale6` are the 3+ / 6+ bottle prices this project
 * deliberately ignores — it tracks what one bottle costs.
 */
const TIER_SELECTOR = '.product-price-regular-sale3-sale6 .price_regular bdi';

const REGULAR_SELECTOR = '.product-price-regular bdi';

const COUNTRY_LABEL = 'країна';

const TRADEMARK_LABEL = 'торгова марка';

const PRODUCER_LABEL = 'виробник';

const TYPE_LABEL = 'тип';

const ABV_LABEL = 'міцність';

const VOLUME_LABEL = "об'єм";

/**
 * Wine Point (wine-point.ua) — WordPress/WooCommerce, fully server-rendered.
 * Cloudflare only caches in front of it, with no JS challenge. Its price
 * markup is custom rather than the standard `<ins>`/`<del>` pair, which is the
 * one thing that differs from `winewine`.
 */
export class WinePointAdapter extends WooCommerceAdapterBase {
  protected readonly cardSelector = CARD_SELECTOR;

  protected readonly listingUrl = LISTING;

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
   * Reads the card's single-bottle prices out of the store's custom markup:
   * a promotion (current + struck-through old), a bulk-tier block (single-unit
   * price only), or one plain price.
   *
   * @param $ - Cheerio root of the listing page.
   * @param card - The card node.
   * @returns The card's prices.
   */
  protected parsePrices($: CheerioAPI, card: HtmlNode): WooCommercePrices {
    const sale = firstText($, card, SALE_SELECTOR);

    if (sale !== null) {
      return {
        price: parsePrice(sale),
        oldPrice: parsePrice(firstText($, card, SALE_OLD_SELECTOR)),
      };
    }

    const tier = firstText($, card, TIER_SELECTOR);

    if (tier !== null) {
      return { price: parsePrice(tier), oldPrice: null };
    }

    return {
      price: parsePrice(firstText($, card, REGULAR_SELECTOR)),
      oldPrice: null,
    };
  }

  /**
   * Fills country/brand/type/ABV/volume from the product page's attributes.
   *
   * @param snap - The snapshot to fill; mutated in place, per the adapter
   *   contract.
   * @param attributes - Lower-cased attribute label to value.
   */
  protected applyAttributes(
    snap: ProductSnapshot,
    attributes: ReadonlyMap<string, string>,
  ): void {
    snap.country ??= this.normalizer.canonicalCountry(
      attributes.get(COUNTRY_LABEL),
    );
    snap.whiskyType ??= this.normalizer.extractType(
      attributes.get(TYPE_LABEL) ?? '',
    );
    snap.abv ??= this.normalizer.parseAbvValue(attributes.get(ABV_LABEL));
    snap.volumeMl ??= this.normalizer.parseVolumeValue(
      attributes.get(VOLUME_LABEL),
    );

    if (snap.brand === null || snap.brand === '') {
      snap.brand = this.readBrand(attributes);
    }
  }

  /**
   * The brand from the specification table: the trademark first, the producer
   * as a fallback.
   *
   * @param attributes - Lower-cased attribute label to value.
   * @returns The brand, or null when neither label carries a value.
   */
  private readBrand(attributes: ReadonlyMap<string, string>): string | null {
    const trademark = attributes.get(TRADEMARK_LABEL);

    if (trademark !== undefined && trademark !== '') {
      return trademark;
    }

    const producer = attributes.get(PRODUCER_LABEL);

    return producer !== undefined && producer !== '' ? producer : null;
  }
}
