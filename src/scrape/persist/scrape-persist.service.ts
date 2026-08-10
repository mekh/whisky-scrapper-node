import { Injectable, Logger } from '@nestjs/common';
import { Transactional } from 'typeorm-transactional';

import { PERSIST_SWEEP_GUARD_RATIO } from '~constants';
import { CoreBrandService } from '~core/brand';
import { CoreCountryService } from '~core/country';
import { CoreFlavorService } from '~core/flavor';
import { CorePriceSnapshotService } from '~core/price-snapshot';
import { CoreProductService } from '~core/product';
import { CoreTypeService } from '~core/type';
import { ProductNameUtils } from '~utils';

import type { ID, ProductSnapshot } from '~types';

import type { PersistCounts } from './scrape-persist.interfaces';

/**
 * Writes a store's scraped in-stock snapshots and flags its out-of-stock
 * products in a single transaction. Lookup names are resolved to ids in batch
 * up front, then each product is upserted with its flavors and today's price
 * snapshot. Nothing is ever deleted — availability is the `product.inStock`
 * flag, so price history survives out-of-stock periods.
 */
@Injectable()
export class ScrapePersistService {
  private readonly logger = new Logger(ScrapePersistService.name);

  private readonly brands: CoreBrandService;

  private readonly types: CoreTypeService;

  private readonly flavors: CoreFlavorService;

  private readonly countries: CoreCountryService;

  private readonly products: CoreProductService;

  private readonly snapshots: CorePriceSnapshotService;

  public constructor(
    brands: CoreBrandService,
    types: CoreTypeService,
    flavors: CoreFlavorService,
    countries: CoreCountryService,
    products: CoreProductService,
    snapshots: CorePriceSnapshotService,
  ) {
    this.brands = brands;
    this.types = types;
    this.flavors = flavors;
    this.countries = countries;
    this.products = products;
    this.snapshots = snapshots;
  }

  /**
   * Persists a store's collection: upserts every in-stock snapshot and flags
   * the products the run did not see in stock, all in one transaction.
   *
   * @param storeId - The store being written.
   * @param inStock - Normalized in-stock snapshots to upsert.
   * @param oosSkus - SKUs the listing explicitly returned as out of stock.
   * @param capturedOn - The capture day (`YYYY-MM-DD`) for the snapshots.
   * @param backfill - Whether the upsert also fills the still-null columns of
   * the rows it updates.
   * @returns How many products were stored, added (new) and flagged out of
   * stock.
   */
  @Transactional()
  public async persist(
    storeId: ID,
    inStock: ProductSnapshot[],
    oosSkus: string[],
    capturedOn: string,
    backfill = false,
  ): Promise<PersistCounts> {
    const inStockBefore = await this.products.countByStore(storeId);

    const brandIds = await this.brands.resolveByName(
      this.distinct(inStock.map((snap) => snap.brand)),
    );
    const typeIds = await this.types.resolveByName(
      this.distinct(inStock.map((snap) => snap.whiskyType)),
    );
    const flavorIds = await this.flavors.resolveByName(
      this.distinct([
        ...inStock.flatMap((snap) => snap.flavorTags),
        ...inStock.flatMap((snap) => snap.llmFlavorTags ?? []),
      ]),
    );
    const countryIds = await this.countries.resolveByNameUa(
      this.distinct(inStock.map((snap) => snap.country)),
    );

    let stored = 0;
    let added = 0;

    for (const snap of inStock) {
      const country = snap.country
        ? countryIds.get(snap.country.trim().toLowerCase()) ?? null
        : null;

      const result = await this.products.upsertFromScrape({
        storeId,
        sku: snap.storeSku,
        url: snap.url,
        nameOrig: snap.name,
        name: snap.cleanName ?? ProductNameUtils.clean(snap.name),
        brandId: snap.brand ? brandIds.get(snap.brand) ?? null : null,
        typeId: snap.whiskyType ? typeIds.get(snap.whiskyType) ?? null : null,
        countryId: country,
        age: snap.ageYears,
        abv: snap.abv,
        volumeMl: snap.volumeMl,
        seenOn: capturedOn,
      }, backfill);

      await this.products.setFlavors(
        result.id,
        snap.flavorTags
          .map((tag) => flavorIds.get(tag))
          .filter((id): id is ID => id !== undefined),
      );

      /**
       * Only when the classification pass actually answered. The pass runs for
       * new SKUs only, and writing on an unanswered item would stamp
       * `lastLlmFlavorAt` and so hide the product from the backfill script
       * forever.
       */
      if (snap.llmFlavorChecked) {
        await this.products.setLlmFlavors(
          result.id,
          (snap.llmFlavorTags ?? [])
            .map((tag) => flavorIds.get(tag))
            .filter((id): id is ID => id !== undefined),
        );
      }

      await this.snapshots.upsertForDate(result.id, capturedOn, {
        price: snap.price,
        oldPrice: snap.oldPrice,
        currency: snap.currency,
        inStock: snap.inStock,
        promo: snap.promo,
      });

      stored += 1;

      if (result.isNew) {
        added += 1;
      }
    }

    const removed = await this.flagOutOfStock(
      storeId,
      inStock.map((snap) => snap.storeSku),
      oosSkus,
      inStockBefore,
    );

    return { stored, added, removed };
  }

  /**
   * Flags this run's unavailable products. Normally a sweep: every product of
   * the store not seen in stock this run (explicitly out of stock or missing
   * from the listing) is flagged. When the run's in-stock count is
   * suspiciously low against the pre-run baseline — a likely truncated
   * listing — the sweep is skipped and only the explicit out-of-stock SKUs
   * are flagged. A store that legitimately shrank past the guard keeps
   * warning on every run until its stock recovers or the rows are fixed
   * manually; a wrongly flagged product self-heals on the next run.
   *
   * @param storeId - The store being written.
   * @param inStockSkus - SKUs seen in stock this run.
   * @param oosSkus - SKUs the listing explicitly returned as out of stock.
   * @param baseline - The store's in-stock product count before this run.
   * @returns How many products were flagged out of stock.
   */
  private async flagOutOfStock(
    storeId: ID,
    inStockSkus: string[],
    oosSkus: string[],
    baseline: number,
  ): Promise<number> {
    const sweepIsSafe =
      inStockSkus.length >= baseline * PERSIST_SWEEP_GUARD_RATIO;

    if (sweepIsSafe) {
      return this.products.markOutOfStockExcept(storeId, inStockSkus);
    }

    this.logger.warn(
      'Listing looks truncated (%d in stock vs %d stored); '
        + 'flagging only the explicit out-of-stock SKUs',
      inStockSkus.length,
      baseline,
    );

    return this.products.markOutOfStockBySkus(storeId, oosSkus);
  }

  /**
   * Collects the distinct non-empty values of a nullable string list.
   *
   * @param values - Values to dedupe.
   * @returns The distinct non-empty values.
   */
  private distinct(values: (string | null)[]): string[] {
    return [
      ...new Set(
        values.filter((value): value is string => Boolean(value)),
      ),
    ];
  }
}
