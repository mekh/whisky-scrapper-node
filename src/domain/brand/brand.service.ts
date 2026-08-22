import { Injectable } from '@nestjs/common';

import { SEARCH_DEFAULT_LIMIT } from '~constants';
import { CoreBrandService } from '~core/brand';
import { SearchQuery, TypeBrand } from '~types';

/**
 * Business layer for the brand read the blacklist autocomplete drives. Thin
 * today; its job is owning the search policy (the default limit) so the
 * controller stays transport-only.
 */
@Injectable()
export class BrandService {
  public constructor(private readonly brands: CoreBrandService) {}

  /**
   * Autocomplete search over brand names, best matches first.
   *
   * The default limit is applied here rather than in the controller — it is
   * business policy, not transport.
   *
   * @param query - The term and an optional row limit.
   * @returns Matching brands, best matches first.
   */
  public async search(query: SearchQuery): Promise<TypeBrand[]> {
    return this.brands.searchByName(
      query.q,
      query.limit ?? SEARCH_DEFAULT_LIMIT,
    );
  }
}
