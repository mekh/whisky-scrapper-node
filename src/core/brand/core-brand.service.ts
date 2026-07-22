import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';

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
}
