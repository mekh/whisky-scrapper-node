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

const LISTING = 'https://winewine.ua/whiskey/';

const CARD_SELECTOR = 'li.product.type-product';

const COUNTRY_LABEL = 'країна';

const BRAND_LABEL = 'бренд';

const TYPE_LABEL = 'тип';

/**
 * The exact strength; `міцність` carries a range and is only a fallback.
 */
const ABV_LABEL = 'алкоголь';

const ABV_RANGE_LABEL = 'міцність';

const VOLUME_LABEL = 'літраж';

/**
 * WineWine (winewine.ua) — WordPress/WooCommerce, fully server-rendered, with
 * the standard `<ins>`/`<del>` price markup. Everything but the price comes
 * from the shared WooCommerce base; the product page's attribute table carries
 * country/brand/type/ABV/volume.
 */
export class WinewineAdapter extends WooCommerceAdapterBase {
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
   * Reads the card's prices: the current one from `<ins>` when the item is on
   * promotion, otherwise the single amount, with `<del>` as the old price.
   *
   * @param $ - Cheerio root of the listing page.
   * @param card - The card node.
   * @returns The card's prices.
   */
  protected parsePrices($: CheerioAPI, card: HtmlNode): WooCommercePrices {
    const sale = firstText($, card, 'ins bdi');
    const price = sale === null
      ? parsePrice(firstText($, card, '.woocommerce-Price-amount bdi'))
      : parsePrice(sale);

    return { price, oldPrice: parsePrice(firstText($, card, 'del bdi')) };
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
    const brand = attributes.get(BRAND_LABEL);

    snap.country ??= this.normalizer.canonicalCountry(
      attributes.get(COUNTRY_LABEL),
    );
    snap.whiskyType ??= this.normalizer.extractType(
      attributes.get(TYPE_LABEL) ?? '',
    );
    snap.abv ??= this.normalizer.parseAbvValue(attributes.get(ABV_LABEL))
      ?? this.normalizer.parseAbvValue(attributes.get(ABV_RANGE_LABEL));
    snap.volumeMl ??= this.normalizer.parseVolumeValue(
      attributes.get(VOLUME_LABEL),
    );

    if (snap.brand === null || snap.brand === '') {
      snap.brand = brand === undefined || brand === '' ? null : brand;
    }
  }
}
