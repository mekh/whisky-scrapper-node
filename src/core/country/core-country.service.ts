import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';

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
}
