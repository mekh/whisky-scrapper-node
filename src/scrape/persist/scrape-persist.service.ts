import { Injectable } from '@nestjs/common';
import { Transactional } from 'typeorm-transactional';

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
 * Writes a store's scraped in-stock snapshots plus its out-of-stock removals in
 * a single transaction, mirroring the Python `store_snapshots` +
 * `delete_products`. Lookup names are resolved to ids in batch up front, then
 * each product is upserted with its flavors and today's price snapshot.
 */
@Injectable()
export class ScrapePersistService {
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
   * Persists a store's collection: upserts every in-stock snapshot and removes
   * the out-of-stock products, all in one transaction.
   *
   * @param storeId - The store being written.
   * @param inStock - Normalized in-stock snapshots to upsert.
   * @param oosSkus - SKUs the listing returned as out of stock, to delete.
   * @param capturedOn - The capture day (`YYYY-MM-DD`) for the snapshots.
   * @returns How many products were stored, added (new) and removed.
   */
  @Transactional()
  public async persist(
    storeId: ID,
    inStock: ProductSnapshot[],
    oosSkus: string[],
    capturedOn: string,
  ): Promise<PersistCounts> {
    const brandIds = await this.brands.resolveByName(
      this.distinct(inStock.map((snap) => snap.brand)),
    );
    const typeIds = await this.types.resolveByName(
      this.distinct(inStock.map((snap) => snap.whiskyType)),
    );
    const flavorIds = await this.flavors.resolveByName(
      this.distinct(inStock.flatMap((snap) => snap.flavorTags)),
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
        name: ProductNameUtils.clean(snap.name),
        brandId: snap.brand ? brandIds.get(snap.brand) ?? null : null,
        typeId: snap.whiskyType ? typeIds.get(snap.whiskyType) ?? null : null,
        countryId: country,
        age: snap.ageYears,
        abv: snap.abv,
        volumeMl: snap.volumeMl,
        seenOn: capturedOn,
      });

      await this.products.setFlavors(
        result.id,
        snap.flavorTags
          .map((tag) => flavorIds.get(tag))
          .filter((id): id is ID => id !== undefined),
      );

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

    const removed = await this.products.deleteBySkus(storeId, oosSkus);

    return { stored, added, removed };
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
