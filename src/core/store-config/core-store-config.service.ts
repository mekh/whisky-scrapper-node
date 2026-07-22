import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';

import { StoreConfigEntity } from './store-config.entity';
import { StoreConfigRepository } from './store-config.repository';

/**
 * Persistence-layer public API for the `store_config` entity.
 */
@Injectable()
export class CoreStoreConfigService extends CoreBaseService<StoreConfigEntity> {
  protected readonly uniqueFields: 'storeId'[] = ['storeId'];

  public constructor(protected readonly repo: StoreConfigRepository) {
    super(repo);
  }
}
