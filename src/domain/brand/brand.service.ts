import { Injectable } from '@nestjs/common';

import { SEARCH_DEFAULT_LIMIT } from '~constants';
import { CoreProducerService } from '~core/producer';
import { SearchQuery, TypeBrand } from '~types';

/**
 * Business layer for the brand read the blacklist autocomplete drives. Thin
 * today; its job is owning the search policy (the default limit) so the
 * controller stays transport-only.
 *
 * "Brand" is the word the API keeps, because it is the word a shopper uses
 * and what `/brand/search` has always answered with. What it searches is the
 * knowledge base's producers, through their aliases — so the picker now finds
 * `Jura` from `isle of jura`, and it can no longer offer two rows for one
 * maker, which is what let a user blacklist `Chivas` and `Chivas Regal`
 * separately and hide neither properly.
 */
@Injectable()
export class BrandService {
  public constructor(private readonly producers: CoreProducerService) {}

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
    return this.producers.searchByName(
      query.q,
      query.limit ?? SEARCH_DEFAULT_LIMIT,
    );
  }
}
