import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import { ID } from '~types';

import { BrandEntity } from './brand.entity';
import { BrandRepository } from './brand.repository';

/**
 * Persistence-layer public API for the `brand` entity.
 */
@Injectable()
export class CoreBrandService extends CoreBaseService<BrandEntity> {
  protected readonly uniqueFields: 'name'[] = ['name'];

  public constructor(protected readonly repo: BrandRepository) {
    super(repo);
  }

  /**
   * Resolves brand names to ids, creating any missing ones.
   *
   * @param names - Brand names; blanks and duplicates are ignored.
   * @returns Map from each present name to its id.
   */
  public async resolveByName(names: string[]): Promise<Map<string, ID>> {
    return this.repo.getOrCreateByName(names);
  }
}
