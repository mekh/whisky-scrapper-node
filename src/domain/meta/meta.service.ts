import { Injectable } from '@nestjs/common';

import { DEFAULT_PER_PAGE, PERIOD_WINDOWS, PER_PAGE_OPTIONS } from '~constants';
import { CoreCountryService } from '~core/country';
import { CoreFlavorService } from '~core/flavor';
import { CoreProductService } from '~core/product';
import { CoreStoreService } from '~core/store';
import { CoreTypeService } from '~core/type';
import { Meta, MetaCountry, MetaStore } from '~types';

@Injectable()
export class MetaService {
  public constructor(
    private readonly stores: CoreStoreService,
    private readonly flavors: CoreFlavorService,
    private readonly types: CoreTypeService,
    private readonly products: CoreProductService,
    private readonly countries: CoreCountryService,
  ) {}

  /**
   * Builds the filter-form metadata: available stores, flavor/type chips, the
   * countries present in the catalog, and pagination/window options. Every
   * list is sourced from the database.
   *
   * @returns The aggregated filter metadata.
   */
  public async build(): Promise<Meta> {
    const [stores, flavors, types, countries, allCountries] = await Promise
      .all([
        this.stores.findAllWithConfig(),
        this.flavors.allNames(),
        this.types.allNames(),
        this.products.distinctCountries(),
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
