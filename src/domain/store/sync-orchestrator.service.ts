import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { SyncConfig } from '~config';
import { CoreStoreService } from '~core/store';
import { CoreSyncLogService } from '~core/sync-log';
import { SyncEngine, SyncTrigger } from '~enums';
import { BadRequestError, DuplicateError, NotFoundError } from '~errors';
import { SyncFileLogService, SyncFileLogWriter } from '~lib/sync-file-log';
import { ScrapeService } from '~scrape';
import type {
  EntitySyncLog,
  ID,
  ScrapeProgressEvent,
  ScrapeProgressReporter,
  SiteResult,
  StoreListItem,
  SyncOutcome,
  SyncRunReport,
  SyncStoreReport,
  SyncTrackReport,
} from '~types';
import { ArrayUtils, DurationUtils, ErrorUtils } from '~utils';

/**
 * A run that holds its lock: the open row plus the writer of its log file.
 * Local to this service — it is what `acquireRun` hands to `runStoreSync`.
 */
interface AcquiredRun {
  /**
   * The open `sync_log` row.
   */
  log: EntitySyncLog;

  /**
   * The writer of this run's log file; disabled when file logging is off.
   */
  writer: SyncFileLogWriter;
}

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
 * File-name prefix of the summary a scheduled full sync writes, beside the
 * per-store files of the runs it drove.
 */
const FULL_RUN_LOG_PREFIX = 'full-run';

/**
 * Owns the lifecycle of store sync runs: validates that a store may be synced,
 * acquires its `sync_log` lock, drives `ScrapeService` in the background, and
 * always closes the row (which releases the lock). Also sweeps locks orphaned
 * by a previous process at boot.
 *
 * Each run additionally writes its own log file. One file per run rather than
 * one per full sync, because tracks are collected concurrently: a shared file
 * would interleave the lines of up to `maxParallelTracks` stores, and a manual
 * sync can start at any moment on top of that.
 */
@Injectable()
export class SyncOrchestratorService implements OnModuleInit {
  private readonly logger = new Logger(SyncOrchestratorService.name);

  public constructor(
    private readonly stores: CoreStoreService,
    private readonly syncLogs: CoreSyncLogService,
    private readonly scrape: ScrapeService,
    private readonly config: SyncConfig,
    private readonly fileLog: SyncFileLogService,
  ) {}

  /**
   * Closes sync runs left open by a previous process. The app runs as a single
   * instance, so any open row at boot is an orphan whose lock must be freed.
   * Expired log files are swept here too, so the retention window also holds
   * on an instance whose schedule is disabled.
   *
   * @returns Resolves once the sweeps are done.
   */
  public async onModuleInit(): Promise<void> {
    const closed = await this.syncLogs.sweepOrphaned();

    if (closed > 0) {
      this.logger.warn(
        'Closed %d orphaned sync run(s) left by a previous process',
        closed,
      );
    }

    await this.sweepLogFiles();
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
    const { log, writer } = await this.acquireRun(store, trigger);
    const run = this
      .runStoreSync(store, log.id, trigger, writer)
      .catch((error: unknown) => {
        this.logger.error('Sync run crashed for %s: %o', store.slug, error);

        return UNKNOWN_FAILURE;
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
   * @returns What every track and store did, for the caller to log.
   */
  public async runFullSync(): Promise<SyncRunReport> {
    const startedAt = Date.now();
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
    const reports: SyncTrackReport[] = [];

    for (const chunk of chunks) {
      const settled = await Promise.allSettled(
        chunk.map((track) => this.runTrack(track)),
      );

      reports.push(...this.trackReports(settled));
    }

    const report: SyncRunReport = {
      durationMs: Date.now() - startedAt,
      tracks: reports,
    };

    await this.writeRunSummary(report, owned.length, tracks.length);
    await this.sweepLogFiles();

    return report;
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
   * Acquires the store's exclusivity lock by opening its `sync_log` row, and
   * opens the log file of the run that won it.
   *
   * The file name is built before the insert so it can be recorded by it — a
   * running row therefore always names its file — while the file itself is
   * only opened once the lock is held, so a run that loses the race leaves
   * nothing behind on disk.
   *
   * @param store - The store to lock.
   * @param trigger - What started this run.
   * @returns The open `sync_log` row and its log file writer.
   * @throws {DuplicateError} When the store or its group is already syncing.
   */
  private async acquireRun(
    store: StoreListItem,
    trigger: SyncTrigger,
  ): Promise<AcquiredRun> {
    const fileName = this.fileLog.buildFileName(store.slug);
    const log = await this.syncLogs.tryStart(
      store.id,
      store.group,
      trigger,
      fileName,
    );

    if (!log) {
      throw new DuplicateError(await this.describeBlocker(store), {
        slug: store.slug,
      });
    }

    this.logger.log('Sync started for %s (%s)', store.slug, trigger);

    return { log, writer: this.fileLog.open(fileName) };
  }

  /**
   * Runs one store's collection, writes its log file and finalizes its
   * `sync_log` row. The row is always closed — that is what releases the lock
   * — so this never rethrows the collection error.
   *
   * The file is closed in its own `finally`, nested inside the one that closes
   * the row: closing the row is what matters most, and neither step may be
   * skipped because the other threw.
   *
   * @param store - The store to collect.
   * @param logId - The open sync-log row id.
   * @param trigger - What started this run, for the file's opening line.
   * @param writer - The run's log file writer.
   * @returns The outcome the row was finalized with.
   */
  private async runStoreSync(
    store: StoreListItem,
    logId: ID,
    trigger: SyncTrigger,
    writer: SyncFileLogWriter,
  ): Promise<SyncOutcome> {
    const startedAt = Date.now();
    let outcome = UNKNOWN_FAILURE;

    writer.header(
      `Sync started for ${store.slug} (${store.name}, tier ${store.tier}, `
        + `${trigger}) ${store.baseUrl}`,
    );

    try {
      const result = await this.collect(store, logId, writer);

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
      writer.footer(
        `Sync finished for ${store.slug} in `
          + `${DurationUtils.format(Date.now() - startedAt)}: `
          + `${result.found} found, ${result.added} added, `
          + `${result.removed} removed`,
      );
    } catch (error) {
      this.logger.error('Sync failed for %s: %o', store.slug, error);
      this.writeFailure(writer, store.slug, error);

      outcome = { ...UNKNOWN_FAILURE, error: ErrorUtils.text(error) };
      writer.footer(
        `Sync FAILED for ${store.slug} after `
          + DurationUtils.format(Date.now() - startedAt),
        'ERROR',
      );
    } finally {
      try {
        await this.syncLogs.finish(logId, outcome);
      } finally {
        await writer.close();
      }
    }

    return outcome;
  }

  /**
   * Writes what a failed run knew about its failure. The stack trace is what
   * the legacy Python log's traceback gave an operator, and the only part that
   * says where the failure came from — the `sync_log` row keeps the message
   * alone.
   *
   * @param writer - The run's log file writer.
   * @param slug - The store that failed.
   * @param error - The caught value.
   */
  private writeFailure(
    writer: SyncFileLogWriter,
    slug: string,
    error: unknown,
  ): void {
    writer.error(`Sync failed for ${slug}: ${ErrorUtils.text(error)}`);

    const stack = ErrorUtils.stack(error);

    if (stack !== null) {
      writer.error(`Traceback:\n${stack}`);
    }
  }

  /**
   * Collects a store under the per-store time budget, which is the larger
   * browser-tier one for a store that drives a headless browser. The timeout
   * only ends the wait: the abandoned collection keeps running until it
   * finishes on its own, but the run is already recorded as failed and its lock
   * released.
   *
   * A second, earlier deadline is handed to the collection for its optional
   * passes — detail enrichment and the LLM passes. They only fill secondary
   * fields, so they are safe to cut short, and a store whose detail pages or
   * model calls run long finishes and persists its catalogue instead of
   * failing the timeout with the whole listing already scraped.
   *
   * @param store - The store to collect.
   * @param logId - The open sync-log row id, for progress touches.
   * @param writer - The run's log file writer.
   * @returns The collection result.
   * @throws {Error} When the store times out.
   */
  private async collect(
    store: StoreListItem,
    logId: ID,
    writer: SyncFileLogWriter,
  ): Promise<SiteResult> {
    const timeoutMs = store.needsBrowser === true
      ? this.config.browserStoreTimeoutMs
      : this.config.storeTimeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    const deadline = AbortSignal.timeout(
      Math.max(0, timeoutMs - this.config.llmDeadlineMarginMs),
    );
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
        reporter: this.buildReporter(logId, writer),
        deadline,
      }),
      expired,
    ]);
  }

  /**
   * Builds the progress sink that mirrors scrape progress into the run's log
   * file and the open `sync_log` row. Both are best-effort: neither a dropped
   * line nor a failed touch may fail the run.
   *
   * @param logId - The open sync-log row id.
   * @param writer - The run's log file writer.
   * @returns The progress reporter.
   */
  private buildReporter(
    logId: ID,
    writer: SyncFileLogWriter,
  ): ScrapeProgressReporter {
    return (event: ScrapeProgressEvent): void => {
      this.writeProgress(writer, event);

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
   * Writes one progress event as a log file line. Page and enrichment
   * progress is `DEBUG` because a large store emits hundreds of those lines;
   * the milestones an operator scans for stay `INFO`.
   *
   * @param writer - The run's log file writer.
   * @param event - The progress event.
   */
  private writeProgress(
    writer: SyncFileLogWriter,
    event: ScrapeProgressEvent,
  ): void {
    switch (event.kind) {
      case 'page':
        writer.debug(
          `Page ${event.page}: ${event.added} new `
            + `(${event.total} collected so far)`,
        );
        break;
      case 'fetched':
        writer.info(
          `Listing fetched: ${event.found} item(s), `
            + `${event.inStock} in stock`,
        );
        break;
      case 'enrich':
        this.writeEnrichProgress(writer, event.done, event.pending);
        break;
      case 'detail-failed':
        writer.warn(`Detail fetch failed for ${event.url}: ${event.error}`);
        break;
      case 'detail-deadline':
        writer.warn(
          'Detail enrichment stopped: out of sync budget, '
            + `${event.pending - event.done} of ${event.pending} item(s) `
            + 'skipped (a backfill run fills their fields)',
        );
        break;
      case 'llm':
        writer.info(
          `LLM ${event.pass} pass: ${event.pending} item(s) to ask about`,
        );
        break;
      case 'llm-deadline':
        writer.warn(
          `LLM ${event.pass} pass skipped: out of LLM budget, `
            + `${event.pending} item(s) left for the next run`,
        );
        break;
      case 'persisted':
        writer.info(
          `Persisted: ${event.stored} stored, ${event.added} added, `
            + `${event.addedProducts} new bottling(s), `
            + `${event.removed} flagged out of stock`,
        );
        break;
      case 'sweep-guarded':
        writer.warn(
          `Listing looks truncated (${event.inStock} in stock vs `
            + `${event.baseline} stored); out-of-stock sweep skipped`,
        );
        break;
    }
  }

  /**
   * Writes detail-enrichment progress, promoting the last line to `INFO` so
   * the finished count is visible without reading the `DEBUG` ones.
   *
   * @param writer - The run's log file writer.
   * @param done - How many items have been enriched.
   * @param pending - How many need enrichment in total.
   */
  private writeEnrichProgress(
    writer: SyncFileLogWriter,
    done: number,
    pending: number,
  ): void {
    const message = `Detail enrichment: ${done}/${pending}`;

    if (done >= pending) {
      writer.info(message);

      return;
    }

    writer.debug(message);
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
   * Keeps the reports of the tracks that resolved. A track cannot reject (each
   * of its stores is guarded), so a rejection here means a bug worth logging.
   *
   * @param settled - The settled track promises of one chunk.
   * @returns The reports that were produced.
   */
  private trackReports(
    settled: PromiseSettledResult<SyncTrackReport>[],
  ): SyncTrackReport[] {
    settled
      .filter((result) => result.status === 'rejected')
      .forEach((result) => {
        this.logger.error('Sync track crashed: %o', result.reason);
      });

    return settled
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value);
  }

  /**
   * Runs one track's stores strictly one at a time.
   *
   * @param track - The stores of this track, in order.
   * @returns What each of the track's stores did.
   */
  private async runTrack(track: StoreListItem[]): Promise<SyncTrackReport> {
    const startedAt = Date.now();
    const key = track[0].group ?? track[0].slug;
    const stores: SyncStoreReport[] = [];

    for (const store of track) {
      stores.push(await this.runScheduledStore(store));
    }

    return { key, durationMs: Date.now() - startedAt, stores };
  }

  /**
   * Syncs one store on behalf of the scheduler. The store is re-validated
   * first, because a full sync can span hours and the schedule was built at
   * its start; a store that cannot start (locked, deactivated meanwhile) is
   * logged and skipped so the track continues.
   *
   * @param store - The store to sync.
   * @returns What this store did, successful or not.
   */
  private async runScheduledStore(
    store: StoreListItem,
  ): Promise<SyncStoreReport> {
    const startedAt = Date.now();

    try {
      const fresh = await this.resolveSyncableStore(store.slug);
      const { log, writer } = await this.acquireRun(fresh, SyncTrigger.CRON);
      const outcome = await this.runStoreSync(
        fresh,
        log.id,
        SyncTrigger.CRON,
        writer,
      );

      return {
        slug: store.slug,
        durationMs: Date.now() - startedAt,
        outcome,
        skipReason: null,
        logFile: writer.fileName,
      };
    } catch (error) {
      const reason = ErrorUtils.text(error);

      /**
       * The reason is logged as text, not as the error object: the structured
       * logger renders a thrown `ErrorBase` without its message, which is the
       * only part that says what blocked the store.
       */
      this.logger.warn('Scheduled sync skipped for %s: %s', store.slug, reason);

      return {
        slug: store.slug,
        durationMs: Date.now() - startedAt,
        outcome: null,
        skipReason: reason,
        logFile: null,
      };
    }
  }

  /**
   * Writes the summary file of a scheduled full sync: one line per track, one
   * per store, and the totals. It is what makes a full sync readable at all —
   * the per-store files each hold one leg of it and cannot say which track set
   * the total duration.
   *
   * @param report - What every track and store did.
   * @param storeCount - How many stores were scheduled.
   * @param trackCount - How many tracks they were split into.
   * @returns Resolves once the summary file is closed.
   */
  private async writeRunSummary(
    report: SyncRunReport,
    storeCount: number,
    trackCount: number,
  ): Promise<void> {
    const fileName = this.fileLog.buildFileName(FULL_RUN_LOG_PREFIX);
    const writer = this.fileLog.open(fileName);

    writer.header(
      `Full sync started: ${storeCount} store(s) in ${trackCount} track(s), `
        + `${this.config.maxParallelTracks} at a time`,
    );

    report.tracks.forEach((track) => {
      writer.info(
        `Track ${track.key} took `
          + `${DurationUtils.format(track.durationMs)}`,
      );
      track.stores.forEach((store) => {
        writer.info(`  ${this.summaryLine(store)}`);
      });
    });

    this.writeRunTotals(writer, report);

    await writer.close();
  }

  /**
   * Writes the closing line of a full-sync summary, as a warning when
   * anything failed or was skipped.
   *
   * @param writer - The summary file's writer.
   * @param report - What every track and store did.
   */
  private writeRunTotals(
    writer: SyncFileLogWriter,
    report: SyncRunReport,
  ): void {
    const stores = report.tracks.flatMap((track) => track.stores);
    const failed = stores.filter((store) => store.outcome?.success === false);
    const skipped = stores.filter((store) => store.outcome === null);
    const ok = stores.length - failed.length - skipped.length;
    const message = 'Full sync finished in '
      + `${DurationUtils.format(report.durationMs)}: ${stores.length} `
      + `store(s), ${ok} ok, ${failed.length} failed, ${skipped.length} `
      + 'skipped';

    writer.footer(
      message,
      failed.length + skipped.length > 0 ? 'WARNING' : 'INFO',
    );
  }

  /**
   * Renders one store's leg of a full sync for the summary file, naming the
   * file that holds its detail.
   *
   * @param store - The store's report.
   * @returns The summary line, without its indent.
   */
  private summaryLine(store: SyncStoreReport): string {
    const duration = DurationUtils.format(store.durationMs);
    const logFile = store.logFile ? ` [${store.logFile}]` : '';

    if (store.outcome === null) {
      return `${store.slug} ${duration} skipped: ${store.skipReason}`;
    }

    if (!store.outcome.success) {
      return `${store.slug} ${duration} FAILED: ${store.outcome.error}`
        + logFile;
    }

    return `${store.slug} ${duration} ok — ${store.outcome.total} found, `
      + `${store.outcome.added} added, ${store.outcome.removed} removed`
      + logFile;
  }

  /**
   * Deletes the log files that outlived the retention window, reporting how
   * many went. Best-effort like the rest of file logging: the sweep must not
   * be able to fail a boot or a sync.
   *
   * @returns Resolves once the sweep is done.
   */
  private async sweepLogFiles(): Promise<void> {
    const deleted = await this.fileLog.sweepRetention();

    if (deleted > 0) {
      this.logger.log('Deleted %d expired sync log file(s)', deleted);
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
}
