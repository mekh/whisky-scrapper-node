import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import { ID } from '~types';

import { SyncLogEntity } from './sync-log.entity';
import { SyncLogRepository } from './sync-log.repository';

/**
 * Persistence-layer public API for the `sync_log` entity.
 */
@Injectable()
export class CoreSyncLogService extends CoreBaseService<SyncLogEntity> {
  public constructor(protected readonly repo: SyncLogRepository) {
    super(repo);
  }

  /**
   * The most recent sync-log entries for a store, newest first.
   *
   * @param storeId - Store id.
   * @param limit - Maximum number of entries to return.
   * @returns The store's latest sync-log entries.
   */
  public async recentByStore(
    storeId: ID,
    limit: number,
  ): Promise<SyncLogEntity[]> {
    return this.findMany(
      { storeId },
      { order: { createdAt: 'DESC' }, take: limit },
    );
  }

  /**
   * The timestamp of each store's most recent successful sync, keyed by store
   * id, for stores that have ever synced successfully.
   *
   * @returns A map of store id to the last successful sync timestamp.
   */
  public async lastSuccessfulByStore(): Promise<Map<ID, Date>> {
    const rows = await this.repo.lastSuccessfulByStore();

    return new Map(rows.map((row) => [row.storeId, row.lastAt]));
  }
}
