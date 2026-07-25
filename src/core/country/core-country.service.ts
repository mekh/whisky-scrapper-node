import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import { ID } from '~types';

import { CountryEntity } from './country.entity';
import { CountryRepository } from './country.repository';

/**
 * Persistence-layer public API for the `country` entity.
 */
@Injectable()
export class CoreCountryService extends CoreBaseService<CountryEntity> {
  protected readonly uniqueFields: 'code'[] = ['code'];

  public constructor(protected readonly repo: CountryRepository) {
    super(repo);
  }

  /**
   * Resolves Ukrainian country names to ids (lookup only; unknown names are
   * absent from the result).
   *
   * @param names - Ukrainian country names to resolve.
   * @returns Map from each matched name (trimmed, lower-cased) to its id.
   */
  public async resolveByNameUa(names: string[]): Promise<Map<string, ID>> {
    return this.repo.resolveByNameUa(names);
  }
}
