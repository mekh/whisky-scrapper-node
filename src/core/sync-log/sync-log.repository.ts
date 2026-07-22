import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { BaseRepository } from '~core/_common';
import { StoreLastSync } from '~types';

import { SyncLogEntity } from './sync-log.entity';

@TypeormRepository(SyncLogEntity)
export class SyncLogRepository extends BaseRepository<SyncLogEntity> {
  /**
   * The timestamp of each store's most recent successful sync, in one query.
   *
   * @returns One row per store that has ever synced successfully, carrying the
   *   latest completion time (falling back to the record's creation time).
   */
  public async lastSuccessfulByStore(): Promise<StoreLastSync[]> {
    return this.createQueryBuilder('log')
      .select('log.storeId', 'storeId')
      .addSelect('MAX(COALESCE(log.finishedAt, log.createdAt))', 'lastAt')
      .where('log.success = :success', { success: true })
      .groupBy('log.storeId')
      .getRawMany<StoreLastSync>();
  }
}
