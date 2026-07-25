import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { SyncConfig } from '~config';
import { CoreStoreService } from '~core/store';
import { CoreSyncLogService } from '~core/sync-log';
import { SyncEngine, SyncTrigger } from '~enums';
import { BadRequestError, DuplicateError, NotFoundError } from '~errors';
import { ScrapeService } from '~scrape';
import type {
  EntitySyncLog,
  ID,
  ScrapeProgressEvent,
  ScrapeProgressReporter,
  SiteResult,
  StoreListItem,
  SyncOutcome,
} from '~types';
import { ArrayUtils } from '~utils';

/**
 * The outcome a run is finalized with when it never reached a terminal state
 * of its own (an unexpected throw outside the collection call).
 */
const UNKNOWN_FAILURE: SyncOutcome = {
  success: false,
  error: 'Sync did not complete',
  added: 0,
  removed: 0,
  updated: 0,
  total: 0,
};

/**
 * Owns the lifecycle of store sync runs: validates that a store may be synced,
 * acquires its `sync_log` lock, drives `ScrapeService` in the background, and
 * always closes the row (which releases the lock). Also sweeps locks orphaned
 * by a previous process at boot.
 */
@Injectable()
export class SyncOrchestratorService implements OnModuleInit {
  private readonly logger = new Logger(SyncOrchestratorService.name);

  public constructor(
    private readonly stores: CoreStoreService,
    private readonly syncLogs: CoreSyncLogService,
    private readonly scrape: ScrapeService,
    private readonly config: SyncConfig,
  ) {}

  /**
   * Closes sync runs left open by a previous process. The app runs as a single
   * instance, so any open row at boot is an orphan whose lock must be freed.
   *
   * @returns Resolves once the sweep is done.
   */
  public async onModuleInit(): Promise<void> {
    const closed = await this.syncLogs.sweepOrphaned();

    if (closed > 0) {
      this.logger.warn(
        'Closed %d orphaned sync run(s) left by a previous process',
        closed,
      );
    }
  }

  /**
   * Starts a sync for one store: validates it, acquires the group/store lock
   * and kicks off the run. A manual run is fire-and-forget (the caller gets an
   * immediate 202); a cron run is awaited so a track stays sequential.
   *
   * @param slug - Store slug.
   * @param trigger - What started this run.
   * @returns The open `sync_log` row.
   * @throws {NotFoundError} When no store has the slug.
   * @throws {BadRequestError} When the store cannot be synced by this engine.
   * @throws {DuplicateError} When the store or its group is already syncing.
   */
  public async startStoreSync(
    slug: string,
    trigger: SyncTrigger,
  ): Promise<EntitySyncLog> {
    const store = await this.resolveSyncableStore(slug);
    const log = await this.syncLogs.tryStart(
      store.id,
      store.group,
      trigger,
    );

    if (!log) {
      throw new DuplicateError(await this.describeBlocker(store), { slug });
    }

    this.logger.log('Sync started for %s (%s)', store.slug, trigger);

    const run = this.runStoreSync(store, log.id).catch((error: unknown) => {
      this.logger.error('Sync run crashed for %s: %o', store.slug, error);
    });

    if (trigger === SyncTrigger.CRON) {
      await run;
    }

    return log;
  }

  /**
   * Syncs every active TS-owned store: stores are split into concurrency
   * tracks (one per group, plus one per group-less store) and the tracks run
   * in parallel chunks, sequentially inside each track.
   *
   * @returns Resolves once every track is done.
   */
  public async runFullSync(): Promise<void> {
    const all = await this.stores.findAllWithConfig();
    const owned = all.filter(
      (store) => store.active && store.engine === SyncEngine.TS,
    );
    const tracks = this.buildTracks(owned);

    this.logger.log(
      'Full sync: %d store(s) in %d track(s), %d at a time',
      owned.length,
      tracks.length,
      this.config.maxParallelTracks,
    );

    const chunks = ArrayUtils.chunkify(tracks, this.config.maxParallelTracks);

    for (const chunk of chunks) {
      await Promise.allSettled(chunk.map((track) => this.runTrack(track)));
    }
  }

  /**
   * Loads a store and rejects it when this engine must not sync it.
   *
   * @param slug - Store slug.
   * @returns The store with its scrape config.
   * @throws {NotFoundError} When no store has the slug.
   * @throws {BadRequestError} When the store is inactive, unconfigured, or
   * still owned by the legacy Python scraper.
   */
  private async resolveSyncableStore(slug: string): Promise<StoreListItem> {
    const store = await this.stores.findWithConfigBySlug(slug);

    if (!store) {
      throw new NotFoundError('Store not found', { slug });
    }

    if (!store.active) {
      throw new BadRequestError('Store is not active', { slug });
    }

    if (store.tier === null) {
      throw new BadRequestError('Store has no scrape configuration', { slug });
    }

    if (store.engine !== SyncEngine.TS) {
      throw new BadRequestError(
        'Store is still owned by the legacy Python scraper',
        { slug, engine: store.engine },
      );
    }

    return store;
  }

  /**
   * Runs one store's collection and finalizes its `sync_log` row. The row is
   * always closed — that is what releases the lock — so this never rethrows
   * the collection error.
   *
   * @param store - The store to collect.
   * @param logId - The open sync-log row id.
   * @returns Resolves once the row is finalized.
   */
  private async runStoreSync(
    store: StoreListItem,
    logId: ID,
  ): Promise<void> {
    let outcome = UNKNOWN_FAILURE;

    try {
      const result = await this.collect(store, logId);

      outcome = {
        success: true,
        error: null,
        added: result.added,
        removed: result.removed,
        updated: result.stored - result.added,
        total: result.found,
      };

      this.logger.log(
        'Sync finished for %s: %d found, %d added, %d removed',
        store.slug,
        result.found,
        result.added,
        result.removed,
      );
    } catch (error) {
      this.logger.error('Sync failed for %s: %o', store.slug, error);

      outcome = { ...UNKNOWN_FAILURE, error: this.errorText(error) };
    } finally {
      await this.syncLogs.finish(logId, outcome);
    }
  }

  /**
   * Collects a store under the per-store time budget. The timeout only ends
   * the wait: the abandoned collection keeps running until it finishes on its
   * own, but the run is already recorded as failed and its lock released.
   *
   * @param store - The store to collect.
   * @param logId - The open sync-log row id, for progress touches.
   * @returns The collection result.
   * @throws {Error} When the store times out.
   */
  private async collect(
    store: StoreListItem,
    logId: ID,
  ): Promise<SiteResult> {
    const timeoutMs = this.config.storeTimeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    const expired = new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          reject(new Error(`Sync timed out after ${timeoutMs} ms`));
        },
        { once: true },
      );
    });

    return Promise.race([
      this.scrape.collectStore(store.slug, {
        reporter: this.buildReporter(logId),
      }),
      expired,
    ]);
  }

  /**
   * Builds the progress sink that mirrors scrape progress into the open
   * `sync_log` row. Touches are best-effort: a failed one never fails the run.
   *
   * @param logId - The open sync-log row id.
   * @returns The progress reporter.
   */
  private buildReporter(logId: ID): ScrapeProgressReporter {
    return (event: ScrapeProgressEvent): void => {
      const total = this.progressTotal(event);

      if (total === null) {
        return;
      }

      this.syncLogs.touch(logId, total).catch((error: unknown) => {
        this.logger.warn('Progress touch failed: %o', error);
      });
    };
  }

  /**
   * Extracts the running item count from a scrape progress event.
   *
   * @param event - The progress event.
   * @returns The running total, or null when the event carries none.
   */
  private progressTotal(event: ScrapeProgressEvent): number | null {
    if (event.kind === 'page') {
      return event.total;
    }

    if (event.kind === 'fetched') {
      return event.found;
    }

    return null;
  }

  /**
   * Splits stores into concurrency tracks: one per group (its stores run one
   * after another) and one per group-less store.
   *
   * @param stores - The stores to schedule.
   * @returns The tracks, each an ordered list of stores.
   */
  private buildTracks(stores: StoreListItem[]): StoreListItem[][] {
    const tracks = new Map<string, StoreListItem[]>();

    stores.forEach((store) => {
      const key = store.group ?? store.id;
      const track = tracks.get(key);

      if (track) {
        track.push(store);

        return;
      }

      tracks.set(key, [store]);
    });

    return [...tracks.values()];
  }

  /**
   * Runs one track's stores strictly one at a time. A store that cannot start
   * (locked, misconfigured) is logged and skipped, so the track continues.
   *
   * @param track - The stores of this track, in order.
   * @returns Resolves once the track is done.
   */
  private async runTrack(track: StoreListItem[]): Promise<void> {
    for (const store of track) {
      try {
        await this.startStoreSync(store.slug, SyncTrigger.CRON);
      } catch (error) {
        this.logger.warn(
          'Scheduled sync skipped for %s: %o',
          store.slug,
          error,
        );
      }
    }
  }

  /**
   * Builds the 409 message naming what currently holds the lock. The exception
   * filter serializes only the message, so the blocker has to be named there.
   *
   * @param store - The store that could not start.
   * @returns A message describing the blocking run.
   */
  private async describeBlocker(store: StoreListItem): Promise<string> {
    const running = await this.syncLogs.findRunning();
    const blocker = running.find((run) =>
      run.storeId === store.id
      || (store.group !== null && run.group === store.group)
    );

    if (!blocker) {
      return `A sync of ${store.slug} is already running`;
    }

    const since = blocker.startedAt.toISOString();

    if (blocker.storeId === store.id) {
      return `Store ${store.slug} is already syncing (since ${since})`;
    }

    return `Store ${store.slug} shares the "${store.group}" sync group with `
      + `${blocker.storeSlug}, which is already syncing (since ${since})`;
  }

  /**
   * Renders an unknown thrown value as sync-log error text.
   *
   * @param error - The caught value.
   * @returns Its message.
   */
  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
