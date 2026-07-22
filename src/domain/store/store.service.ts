import { Injectable } from '@nestjs/common';

import { CoreProductService } from '~core/product';
import { CoreStoreService } from '~core/store';
import { CoreSyncLogService } from '~core/sync-log';
import { NotFoundError, ServerError } from '~errors';
import { StoreDetail, StoreListItem } from '~types';

const RECENT_SYNC_LIMIT = 10;

@Injectable()
export class StoreService {
  public constructor(
    private readonly stores: CoreStoreService,
    private readonly products: CoreProductService,
    private readonly syncLogs: CoreSyncLogService,
  ) {}

  /**
   * Lists every store with its scrape config.
   *
   * @returns Store + config rows, ordered by name.
   */
  public async list(): Promise<StoreListItem[]> {
    const [items, lastSyncs] = await Promise.all([
      this.stores.findAllWithConfig(),
      this.syncLogs.lastSuccessfulByStore(),
    ]);

    return items.map((item) => ({
      ...item,
      lastSuccessfulSyncAt: lastSyncs.get(item.id) ?? null,
    }));
  }

  /**
   * Loads a store's admin detail: config, creation date, product count, and
   * recent sync-log entries.
   *
   * @param slug - Store slug.
   * @returns The store detail.
   * @throws {NotFoundError} When no store has the slug.
   */
  public async detail(slug: string): Promise<StoreDetail> {
    const item = await this.stores.findWithConfigBySlug(slug);

    if (!item) {
      throw new NotFoundError('Store not found', { slug });
    }

    const entity = await this.stores.findById(item.id);

    if (!entity) {
      throw new ServerError('Store vanished while loading detail', { slug });
    }

    const [productCount, recentSyncs, lastSyncs] = await Promise.all([
      this.products.countByStore(item.id),
      this.syncLogs.recentByStore(item.id, RECENT_SYNC_LIMIT),
      this.syncLogs.lastSuccessfulByStore(),
    ]);

    return {
      ...item,
      lastSuccessfulSyncAt: lastSyncs.get(item.id) ?? null,
      createdAt: entity.createdAt,
      productCount,
      lastSync: recentSyncs[0] ?? null,
      recentSyncs,
    };
  }

  /**
   * Toggles a store's active flag.
   *
   * @param slug - Store slug.
   * @param active - New active value.
   * @returns The updated store + config row.
   * @throws {NotFoundError} When no store has the slug.
   */
  public async setActive(
    slug: string,
    active: boolean,
  ): Promise<StoreListItem> {
    const updated = await this.stores.setActiveBySlug(slug, active);

    if (!updated) {
      throw new NotFoundError('Store not found', { slug });
    }

    const item = await this.stores.findWithConfigBySlug(slug);

    if (!item) {
      throw new ServerError('Store vanished after update', { slug });
    }

    const lastSyncs = await this.syncLogs.lastSuccessfulByStore();

    return { ...item, lastSuccessfulSyncAt: lastSyncs.get(item.id) ?? null };
  }
}
