import { Injectable } from '@nestjs/common';

import {
  CACHE_GENERATION_CATALOGUE,
  CACHE_SCOPE_META,
  DEFAULT_PER_PAGE,
  PERIOD_WINDOWS,
  PER_PAGE_OPTIONS,
} from '~constants';
import { CoreCountryService } from '~core/country';
import { CoreFlavorService } from '~core/flavor';
import { CoreStoreService } from '~core/store';
import { CoreStoreProductService } from '~core/store-product';
import { CoreTypeService } from '~core/type';
import { ScotlandLegalRegion, ScotlandRegion } from '~enums';
import { VersionedCacheService } from '~lib/cache';
import { Meta, MetaCountry, MetaStore } from '~types';

@Injectable()
export class MetaService {
  public constructor(
    private readonly stores: CoreStoreService,
    private readonly flavors: CoreFlavorService,
    private readonly types: CoreTypeService,
    private readonly offers: CoreStoreProductService,
    private readonly countries: CoreCountryService,
    private readonly cache: VersionedCacheService,
  ) {}

  /**
   * The filter-form metadata, from the cache when the catalogue has not
   * changed since it was built.
   *
   * It hangs off the same generation as the reports even though most of what
   * moves it is different — a sync creating a type or a flavor row, a store
   * being activated, a country becoming referenced. One counter for both
   * costs a recomputation of five small queries whenever a report is
   * invalidated, which is not worth a second counter to avoid.
   *
   * @returns The aggregated filter metadata.
   */
  public async build(): Promise<Meta> {
    return this.cache.getOrCompute(
      { scope: CACHE_SCOPE_META, suffix: '' },
      CACHE_GENERATION_CATALOGUE,
      () => this.load(),
    );
  }

  /**
   * Reads the metadata from the database: available stores, flavor/type
   * chips, the countries present in the catalog, Scotland's regions, and
   * pagination/window options. Every list but the regions is sourced from the
   * database; the regions are closed vocabularies and come from the enums, so
   * a region no producer has been seeded with yet still offers a chip.
   *
   * @returns The aggregated filter metadata.
   */
  private async load(): Promise<Meta> {
    const [stores, flavors, types, countries, allCountries] = await Promise
      .all([
        this.stores.findAllWithConfig(),
        this.flavors.allNames(),
        this.types.allNames(),
        this.offers.distinctCountries(),
        this.countries.findMany(undefined, { order: { nameUa: 'ASC' } }),
      ]);

    return {
      stores: stores.map((store): MetaStore => ({
        slug: store.slug,
        name: store.name,
        tier: store.tier ?? 0,
        needsBrowser: store.needsBrowser ?? false,
        color: store.color,
        active: store.active,
      })),
      flavors,
      types,
      countries,
      regions: Object.values(ScotlandRegion),
      legalRegions: Object.values(ScotlandLegalRegion),
      allCountries: allCountries.map((country): MetaCountry => ({
        code: country.code,
        nameUa: country.nameUa,
        icon: country.icon ?? null,
      })),
      windows: [...PERIOD_WINDOWS],
      perPageOptions: [...PER_PAGE_OPTIONS],
      defaultPerPage: DEFAULT_PER_PAGE,
    };
  }
}
