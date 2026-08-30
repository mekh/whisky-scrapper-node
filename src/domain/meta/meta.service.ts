import { Injectable } from '@nestjs/common';

import { DEFAULT_PER_PAGE, PERIOD_WINDOWS, PER_PAGE_OPTIONS } from '~constants';
import { CoreCountryService } from '~core/country';
import { CoreFlavorService } from '~core/flavor';
import { CoreStoreService } from '~core/store';
import { CoreStoreProductService } from '~core/store-product';
import { CoreTypeService } from '~core/type';
import { ScotlandLegalRegion, ScotlandRegion } from '~enums';
import { Meta, MetaCountry, MetaStore } from '~types';

@Injectable()
export class MetaService {
  public constructor(
    private readonly stores: CoreStoreService,
    private readonly flavors: CoreFlavorService,
    private readonly types: CoreTypeService,
    private readonly offers: CoreStoreProductService,
    private readonly countries: CoreCountryService,
  ) {}

  /**
   * Builds the filter-form metadata: available stores, flavor/type chips, the
   * countries present in the catalog, Scotland's regions, and
   * pagination/window options. Every list but the regions is sourced from the
   * database; the regions are closed vocabularies and come from the enums, so
   * a region no producer has been seeded with yet still offers a chip.
   *
   * @returns The aggregated filter metadata.
   */
  public async build(): Promise<Meta> {
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
