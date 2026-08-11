import { Injectable } from '@nestjs/common';

import { CoreStoreService } from '~core/store';
import { CoreStoreProductService } from '~core/store-product';
import { CoreSyncLogService } from '~core/sync-log';
import { SyncTrigger } from '~enums';
import { NotFoundError, ServerError } from '~errors';
import { SyncFileLogService } from '~lib/sync-file-log';
import {
  EntitySyncLog,
  ID,
  StoreDetail,
  StoreListItem,
  StoreSyncStatus,
} from '~types';

import { SyncOrchestratorService } from './sync-orchestrator.service';

const RECENT_SYNC_LIMIT = 10;

@Injectable()
export class StoreService {
  public constructor(
    private readonly stores: CoreStoreService,
    private readonly offers: CoreStoreProductService,
    private readonly syncLogs: CoreSyncLogService,
    private readonly orchestrator: SyncOrchestratorService,
    private readonly fileLog: SyncFileLogService,
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
      this.offers.countByStore(item.id),
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

  /**
   * Starts an on-demand sync of one store. Returns as soon as the run is
   * registered — the collection itself continues in the background.
   *
   * @param slug - Store slug.
   * @returns The open sync-log row.
   * @throws {NotFoundError} When no store has the slug.
   * @throws {BadRequestError} When the store cannot be synced by this engine.
   * @throws {DuplicateError} When the store or its group is already syncing.
   */
  public async sync(slug: string): Promise<EntitySyncLog> {
    return this.orchestrator.startStoreSync(slug, SyncTrigger.MANUAL);
  }

  /**
   * Reads back the log file one of a store's sync runs wrote. This is the only
   * account of what a finished run did beyond its counters — the file holds
   * its pages, its LLM passes and, when it failed, its stack trace.
   *
   * @param slug - Store slug.
   * @param id - Id of the store's sync-log row.
   * @returns The file's text.
   * @throws {NotFoundError} When no store has the slug, the row is not that
   * store's, the run wrote no file, or the file is gone (expired by the
   * retention sweep, or written by a deployment that had file logging off).
   */
  public async syncLogFile(slug: string, id: ID): Promise<string> {
    const store = await this.stores.findWithConfigBySlug(slug);

    if (!store) {
      throw new NotFoundError('Store not found', { slug });
    }

    const log = await this.syncLogs.findById(id);

    if (!log || log.storeId !== store.id || !log.logFile) {
      throw new NotFoundError('Sync log file not found', { slug, id });
    }

    const content = await this.fileLog.readLogFile(log.logFile);

    if (content === null) {
      throw new NotFoundError('Sync log file not found', { slug, id });
    }

    return content;
  }

  /**
   * Lists the syncs currently in flight, for the stores page to poll.
   *
   * @returns One entry per running sync, oldest first.
   */
  public async syncStatus(): Promise<StoreSyncStatus[]> {
    const running = await this.syncLogs.findRunning();

    return running.map((run) => ({
      storeId: run.storeId,
      storeSlug: run.storeSlug,
      group: run.group,
      startedAt: run.startedAt,
      total: run.total,
    }));
  }
}
