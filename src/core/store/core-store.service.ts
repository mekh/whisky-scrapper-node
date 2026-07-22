import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import { StoreListItem } from '~types';

import { StoreEntity } from './store.entity';
import { StoreRepository } from './store.repository';

/**
 * Persistence-layer public API for the `store` entity, including the joined
 * store + scrape-config read views used by the meta and admin endpoints.
 */
@Injectable()
export class CoreStoreService extends CoreBaseService<StoreEntity> {
  protected readonly uniqueFields: 'slug'[] = ['slug'];

  public constructor(protected readonly repo: StoreRepository) {
    super(repo);
  }

  /**
   * Every store with its scrape config, ordered by name.
   *
   * @returns Store + config rows.
   */
  public async findAllWithConfig(): Promise<StoreListItem[]> {
    return this.repo.findAllWithConfig();
  }

  /**
   * A single store with its scrape config by slug.
   *
   * @param slug - Store slug.
   * @returns The store + config row, or null when unknown.
   */
  public async findWithConfigBySlug(
    slug: string,
  ): Promise<StoreListItem | null> {
    return this.repo.findWithConfigBySlug(slug);
  }

  /**
   * Toggles a store's active flag by slug.
   *
   * @param slug - Store slug.
   * @param active - New active value.
   * @returns True when a store was updated, false when the slug is unknown.
   */
  public async setActiveBySlug(
    slug: string,
    active: boolean,
  ): Promise<boolean> {
    return this.repo.setActiveBySlug(slug, active);
  }
}
