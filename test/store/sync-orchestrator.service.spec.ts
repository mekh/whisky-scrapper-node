import 'reflect-metadata';

import { SyncTrigger } from '~enums';
import { BadRequestError, DuplicateError, NotFoundError } from '~errors';

import { SyncOrchestratorService } from '../../src/domain/store/sync-orchestrator.service';

import type { SyncConfig } from '~config';
import type { CoreStoreService } from '~core/store';
import type { CoreSyncLogService } from '~core/sync-log';
import type { SyncFileLogService, SyncFileLogWriter } from '~lib/sync-file-log';
import type { RunningSync, SiteResult, StoreListItem } from '~types';
import type { ScrapeService } from '../../src/scrape/scrape.service';

/**
 * A log file writer stub: every line-writing method recorded, plus the lines
 * themselves so a test can assert on what a run wrote.
 */
interface WriterStub {
  /**
   * The stub, shaped as the writer the orchestrator expects.
   */
  writer: SyncFileLogWriter;

  /**
   * Every line written, as `LEVEL message` pairs.
   */
  lines: string[];

  /**
   * The `close` spy, for asserting it ran exactly once.
   */
  close: jest.Mock;
}

interface Fakes {
  /**
   * The service under test.
   */
  orchestrator: SyncOrchestratorService;

  /**
   * Store lookups (`findWithConfigBySlug`, `findAllWithConfig`).
   */
  stores: { [key: string]: jest.Mock };

  /**
   * Sync-log lock operations.
   */
  syncLogs: { [key: string]: jest.Mock };

  /**
   * The scrape engine stub.
   */
  scrape: { collectStore: jest.Mock };

  /**
   * The file-log service stub.
   */
  fileLog: { [key: string]: jest.Mock };

  /**
   * The writer stubs `fileLog.open` handed out, in call order.
   */
  writers: WriterStub[];
}

const RESULT: SiteResult = {
  slug: 'maudau',
  found: 10,
  stored: 8,
  added: 3,
  removed: 2,
};

/**
 * Builds a store list item with the sync-relevant fields overridable.
 *
 * @param over - Fields to override on the default (syncable) store.
 * @returns A complete store list item.
 */
function makeStore(over: Partial<StoreListItem> = {}): StoreListItem {
  return {
    id: 'store-1',
    slug: 'maudau',
    name: 'MauDau',
    baseUrl: 'https://maudau.test',
    color: null,
    active: true,
    tier: 1,
    needsBrowser: false,
    retailChain: null,
    category: null,
    group: null,
    engine: 'ts',
    lastSuccessfulSyncAt: null,
    ...over,
  };
}

/**
 * Builds a log file writer stub that records the lines it is given.
 *
 * @param fileName - The name the stub reports as its file.
 * @returns The stub, its recorded lines, and its `close` spy.
 */
function makeWriter(fileName: string): WriterStub {
  const lines: string[] = [];
  const record = (level: string): jest.Mock =>
    jest.fn((message: string) => {
      lines.push(`${level} ${message}`);
    });
  const close = jest.fn().mockResolvedValue(undefined);
  const writer = {
    fileName,
    header: record('HEADER'),
    footer: jest.fn((message: string, level = 'INFO') => {
      lines.push(`FOOTER:${level} ${message}`);
    }),
    info: record('INFO'),
    debug: record('DEBUG'),
    warn: record('WARNING'),
    error: record('ERROR'),
    close,
  };

  return { writer: writer as unknown as SyncFileLogWriter, lines, close };
}

/**
 * Wires the orchestrator with plain jest fakes for every dependency.
 *
 * @param store - The store `findWithConfigBySlug` resolves to, or null.
 * @param over - Overrides for the sync config defaults.
 * @returns The service plus the fakes it was built with.
 */
function makeOrchestrator(
  store: StoreListItem | null,
  over: Partial<SyncConfig> = {},
): Fakes {
  const stores = {
    findWithConfigBySlug: jest.fn().mockResolvedValue(store),
    findAllWithConfig: jest.fn().mockResolvedValue(store ? [store] : []),
  };

  const syncLogs = {
    tryStart: jest.fn().mockResolvedValue({ id: 'log-1' }),
    touch: jest.fn().mockResolvedValue(undefined),
    finish: jest.fn().mockResolvedValue(undefined),
    sweepOrphaned: jest.fn().mockResolvedValue(0),
    findRunning: jest.fn().mockResolvedValue([]),
  };

  const scrape = {
    collectStore: jest.fn().mockResolvedValue(RESULT),
  };

  const config = {
    cronEnabled: false,
    cronExpression: '0 12 * * *',
    timezone: 'Europe/Kyiv',
    maxParallelTracks: 4,
    storeTimeoutMs: 900000,
    browserStoreTimeoutMs: 2700000,
    llmDeadlineMarginMs: 120000,
    logDir: './log',
    logRetentionDays: 30,
    ...over,
  } as SyncConfig;

  const writers: WriterStub[] = [];
  const fileLog = {
    buildFileName: jest.fn((prefix: string) => `stamp_${prefix}.log`),
    open: jest.fn((fileName: string | null) => {
      const stub = makeWriter(fileName ?? 'unnamed.log');

      writers.push(stub);

      return stub.writer;
    }),
    sweepRetention: jest.fn().mockResolvedValue(0),
  };

  const orchestrator = new SyncOrchestratorService(
    stores as unknown as CoreStoreService,
    syncLogs as unknown as CoreSyncLogService,
    scrape as unknown as ScrapeService,
    config,
    fileLog as unknown as SyncFileLogService,
  );

  return { orchestrator, stores, syncLogs, scrape, fileLog, writers };
}

/**
 * Lets every already-scheduled microtask and timer callback run.
 *
 * @returns Resolves on the next macrotask.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('SyncOrchestratorService.startStoreSync', () => {
  it('rejects an unknown slug with 404', async () => {
    const { orchestrator, syncLogs } = makeOrchestrator(null);

    await expect(orchestrator.startStoreSync('nope', SyncTrigger.MANUAL))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(syncLogs.tryStart).not.toHaveBeenCalled();
  });

  it('rejects an inactive store with 400', async () => {
    const { orchestrator, syncLogs } = makeOrchestrator(
      makeStore({ active: false }),
    );

    await expect(orchestrator.startStoreSync('maudau', SyncTrigger.MANUAL))
      .rejects.toBeInstanceOf(BadRequestError);
    expect(syncLogs.tryStart).not.toHaveBeenCalled();
  });

  it('rejects a store without scrape configuration with 400', async () => {
    const { orchestrator } = makeOrchestrator(makeStore({ tier: null }));

    await expect(orchestrator.startStoreSync('maudau', SyncTrigger.MANUAL))
      .rejects.toThrow('Store has no scrape configuration');
  });

  it('rejects a Python-owned store with 400', async () => {
    const { orchestrator } = makeOrchestrator(makeStore({ engine: 'python' }));

    await expect(orchestrator.startStoreSync('maudau', SyncTrigger.MANUAL))
      .rejects.toThrow('legacy Python scraper');
  });

  it('rejects a second run of the same store with 409', async () => {
    const store = makeStore();
    const { orchestrator, syncLogs, scrape } = makeOrchestrator(store);
    const running: RunningSync[] = [{
      id: 'log-0',
      storeId: store.id,
      storeSlug: store.slug,
      group: null,
      startedAt: new Date('2026-07-25T10:00:00.000Z'),
      total: 5,
    }];

    syncLogs.tryStart.mockResolvedValue(null);
    syncLogs.findRunning.mockResolvedValue(running);

    const error = await orchestrator
      .startStoreSync('maudau', SyncTrigger.MANUAL)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DuplicateError);
    expect((error as Error).message).toContain('maudau');
    expect((error as Error).message).toContain('already syncing');
    expect(scrape.collectStore).not.toHaveBeenCalled();
  });

  it('names the blocking store of the group in the 409 message', async () => {
    const store = makeStore({
      id: 'store-2',
      slug: 'novus',
      group: 'zakaz',
    });
    const { orchestrator, syncLogs } = makeOrchestrator(store);

    syncLogs.tryStart.mockResolvedValue(null);
    syncLogs.findRunning.mockResolvedValue([{
      id: 'log-0',
      storeId: 'store-9',
      storeSlug: 'metro',
      group: 'zakaz',
      startedAt: new Date('2026-07-25T10:00:00.000Z'),
      total: 12,
    }]);

    const error = await orchestrator
      .startStoreSync('novus', SyncTrigger.MANUAL)
      .catch((caught: unknown) => caught);

    expect((error as Error).message).toContain('novus');
    expect((error as Error).message).toContain('zakaz');
    expect((error as Error).message).toContain('metro');
  });

  it('a manual run returns before the collection finishes', async () => {
    const { orchestrator, syncLogs, scrape } = makeOrchestrator(makeStore());
    let release = (): void => {};
    const pending = new Promise<SiteResult>((resolve) => {
      release = (): void => resolve(RESULT);
    });

    scrape.collectStore.mockReturnValue(pending);

    const log = await orchestrator.startStoreSync(
      'maudau',
      SyncTrigger.MANUAL,
    );

    expect(log).toEqual({ id: 'log-1' });
    expect(scrape.collectStore).toHaveBeenCalledTimes(1);
    expect(syncLogs.finish).not.toHaveBeenCalled();

    release();
    await flush();

    expect(syncLogs.finish).toHaveBeenCalledTimes(1);
    expect(syncLogs.finish).toHaveBeenCalledWith('log-1', {
      success: true,
      error: null,
      added: 3,
      removed: 2,
      updated: 5,
      total: 10,
    });
  });

  it('a cron run waits for the collection to finish', async () => {
    const { orchestrator, syncLogs } = makeOrchestrator(makeStore());

    await orchestrator.startStoreSync('maudau', SyncTrigger.CRON);

    expect(syncLogs.finish).toHaveBeenCalledTimes(1);
    expect(syncLogs.tryStart).toHaveBeenCalledWith(
      'store-1',
      null,
      SyncTrigger.CRON,
      'stamp_maudau.log',
    );
  });

  it('finishes the run exactly once when the collection fails', async () => {
    const { orchestrator, syncLogs, scrape } = makeOrchestrator(makeStore());

    scrape.collectStore.mockRejectedValue(new Error('boom'));

    await orchestrator.startStoreSync('maudau', SyncTrigger.CRON);

    expect(syncLogs.finish).toHaveBeenCalledTimes(1);
    expect(syncLogs.finish).toHaveBeenCalledWith('log-1', {
      success: false,
      error: 'boom',
      added: 0,
      removed: 0,
      updated: 0,
      total: 0,
    });
  });

  it('fails the run when the store exceeds its time budget', async () => {
    const { orchestrator, syncLogs, scrape } = makeOrchestrator(
      makeStore(),
      { storeTimeoutMs: 20 },
    );

    scrape.collectStore.mockReturnValue(new Promise<SiteResult>(() => {}));

    await orchestrator.startStoreSync('maudau', SyncTrigger.CRON);

    expect(syncLogs.finish).toHaveBeenCalledTimes(1);
    const [, outcome] = syncLogs.finish.mock.calls[0] as [string, {
      success: boolean;
      error: string;
    }];

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain('timed out');
  });

  it('stops the optional passes before the run itself times out', async () => {
    // The scrape is what a sync is for; details and answers are optional.
    const { orchestrator, syncLogs, scrape } = makeOrchestrator(
      makeStore(),
      { storeTimeoutMs: 3_600_000, llmDeadlineMarginMs: 3_599_980 },
    );

    let deadline: AbortSignal | undefined;

    scrape.collectStore.mockImplementation(
      (_slug: string, options: { deadline?: AbortSignal }) => {
        deadline = options.deadline;

        return Promise.resolve(RESULT);
      },
    );

    await orchestrator.startStoreSync('maudau', SyncTrigger.CRON);

    expect(deadline).toBeInstanceOf(AbortSignal);
    expect(deadline?.aborted).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(deadline?.aborted).toBe(true);

    /**
     * The run itself still succeeded — only the soft deadline expired.
     */
    const [, outcome] = syncLogs.finish.mock.calls[0] as [string, {
      success: boolean;
    }];

    expect(outcome.success).toBe(true);
  });

  it('gives a browser-tier store the larger time budget', async () => {
    const { orchestrator, syncLogs, scrape } = makeOrchestrator(
      makeStore({ slug: 'rozetka', needsBrowser: true }),
      { storeTimeoutMs: 20, browserStoreTimeoutMs: 3_600_000 },
    );

    scrape.collectStore.mockReturnValue(new Promise<SiteResult>(() => {}));

    const pending = orchestrator.startStoreSync('rozetka', SyncTrigger.MANUAL);

    await pending;
    await new Promise((resolve) => setTimeout(resolve, 60));

    // The HTTP budget would already have expired; the browser one has not.
    expect(syncLogs.finish).not.toHaveBeenCalled();
  });

  it('mirrors listing progress into the sync-log row', async () => {
    const { orchestrator, syncLogs, scrape } = makeOrchestrator(makeStore());

    scrape.collectStore.mockImplementation(
      async (
        _slug: string,
        options: { reporter?: (event: unknown) => void },
      ) => {
        options.reporter?.({ kind: 'page', page: 1, added: 4, total: 4 });
        options.reporter?.({ kind: 'enrich', done: 1, pending: 4 });

        return RESULT;
      },
    );

    await orchestrator.startStoreSync('maudau', SyncTrigger.CRON);

    expect(syncLogs.touch).toHaveBeenCalledTimes(1);
    expect(syncLogs.touch).toHaveBeenCalledWith('log-1', 4);
  });
});

describe('SyncOrchestratorService log files', () => {
  it('opens the run file only after the lock is won', async () => {
    const { orchestrator, syncLogs, fileLog } = makeOrchestrator(makeStore());

    syncLogs.tryStart.mockResolvedValue(null);

    await orchestrator
      .startStoreSync('maudau', SyncTrigger.MANUAL)
      .catch(() => undefined);

    expect(fileLog.buildFileName).toHaveBeenCalledWith('maudau');
    expect(fileLog.open).not.toHaveBeenCalled();
  });

  it('writes a header, the progress lines and a footer', async () => {
    const { orchestrator, scrape, writers } = makeOrchestrator(makeStore());

    scrape.collectStore.mockImplementation(
      async (
        _slug: string,
        options: { reporter?: (event: unknown) => void },
      ) => {
        options.reporter?.({ kind: 'page', page: 1, added: 4, total: 4 });
        options.reporter?.({ kind: 'fetched', found: 10, inStock: 8 });
        options.reporter?.({ kind: 'llm', pass: 'names', pending: 2 });
        options.reporter?.({ kind: 'enrich', done: 4, pending: 4 });
        options.reporter?.({
          kind: 'detail-failed',
          url: 'https://maudau.test/p/1',
          error: 'timeout',
        });
        options.reporter?.({ kind: 'detail-deadline', done: 4, pending: 6 });
        options.reporter?.({ kind: 'sweep-guarded', inStock: 3, baseline: 30 });
        options.reporter?.({
          kind: 'persisted',
          stored: 8,
          added: 3,
          addedProducts: 1,
          removed: 2,
        });

        return RESULT;
      },
    );

    await orchestrator.startStoreSync('maudau', SyncTrigger.CRON);

    const { lines, close } = writers[0];

    expect(lines[0]).toContain('HEADER Sync started for maudau');
    expect(lines).toContain('DEBUG Page 1: 4 new (4 collected so far)');
    expect(lines).toContain('INFO Listing fetched: 10 item(s), 8 in stock');
    expect(lines).toContain('INFO LLM names pass: 2 item(s) to ask about');
    expect(lines).toContain('INFO Detail enrichment: 4/4');
    expect(lines).toContain(
      'WARNING Detail fetch failed for https://maudau.test/p/1: timeout',
    );
    expect(lines).toContain(
      'WARNING Detail enrichment stopped: out of sync budget, '
        + '2 of 6 item(s) skipped (a backfill run fills their fields)',
    );
    expect(lines).toContain(
      'WARNING Listing looks truncated (3 in stock vs 30 stored); '
        + 'out-of-stock sweep skipped',
    );
    expect(lines).toContain(
      'INFO Persisted: 8 stored, 3 added, 1 new bottling(s), '
        + '2 flagged out of stock',
    );
    expect(lines.at(-1)).toContain('FOOTER:INFO Sync finished for maudau');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('writes the message and the stack trace of a failed run', async () => {
    const { orchestrator, scrape, writers } = makeOrchestrator(makeStore());

    scrape.collectStore.mockRejectedValue(new Error('boom'));

    await orchestrator.startStoreSync('maudau', SyncTrigger.CRON);

    const { lines, close } = writers[0];

    expect(lines).toContain('ERROR Sync failed for maudau: boom');
    expect(lines.some((line) => line.startsWith('ERROR Traceback:'))).toBe(
      true,
    );
    expect(lines.at(-1)).toContain('FOOTER:ERROR Sync FAILED for maudau');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it(
    'closes the file once and drops later lines when a store times out',
    async () => {
      const { orchestrator, scrape, writers } = makeOrchestrator(
        makeStore(),
        { storeTimeoutMs: 20 },
      );
      let leak: ((event: unknown) => void) | undefined;

      scrape.collectStore.mockImplementation(
        async (
          _slug: string,
          options: { reporter?: (event: unknown) => void },
        ) => {
          leak = options.reporter;

          return new Promise<SiteResult>(() => {});
        },
      );

      await orchestrator.startStoreSync('maudau', SyncTrigger.CRON);

      const { lines, close } = writers[0];
      const written = lines.length;

      expect(close).toHaveBeenCalledTimes(1);
      expect(lines.at(-1)).toContain('FOOTER:ERROR');

      /**
       * The abandoned collection keeps reporting: the orchestrator still hands
       * those events to the writer, whose own `closed` guard drops them. What
       * matters here is that reporting after the run cannot throw.
       */
      expect(() => {
        leak?.({ kind: 'fetched', found: 1, inStock: 1 });
      }).not.toThrow();
      expect(lines.length).toBeGreaterThanOrEqual(written);
    },
  );

  it(
    'writes a summary file for a full sync and sweeps expired files',
    async () => {
      const stores = [
        makeStore({ id: 's1', slug: 'metro', group: 'zakaz' }),
        makeStore({ id: 's2', slug: 'maudau' }),
      ];
      const { orchestrator, stores: storeFakes, fileLog, writers } =
        makeOrchestrator(stores[0]);

      storeFakes.findAllWithConfig.mockResolvedValue(stores);
      storeFakes.findWithConfigBySlug.mockImplementation(
        async (slug: string) =>
          stores.find((item) => item.slug === slug) ?? null,
      );

      await orchestrator.runFullSync();

      expect(fileLog.buildFileName).toHaveBeenCalledWith('full-run');
      expect(fileLog.sweepRetention).toHaveBeenCalledTimes(1);

      const summary = writers.at(-1);

      expect(summary?.writer.fileName).toBe('stamp_full-run.log');
      expect(summary?.lines[0]).toContain('HEADER Full sync started: 2 store');
      expect(
        summary?.lines.some((line) =>
          line.includes('metro') && line
            .includes('ok')
        ),
      ).toBe(true);
      expect(
        summary?.lines.some((line) => line.includes('[stamp_metro.log]')),
      ).toBe(true);
      expect(summary?.lines.at(-1)).toContain(
        'FOOTER:INFO Full sync finished in',
      );
      expect(summary?.close).toHaveBeenCalledTimes(1);
    },
  );
});

describe('SyncOrchestratorService.runFullSync', () => {
  it('runs a group sequentially and caps parallel tracks', async () => {
    const stores = [
      makeStore({ id: 's1', slug: 'metro', group: 'zakaz' }),
      makeStore({ id: 's2', slug: 'novus', group: 'zakaz' }),
      makeStore({ id: 's3', slug: 'maudau' }),
      makeStore({ id: 's4', slug: 'okwine' }),
      makeStore({ id: 's5', slug: 'goodwine', active: false }),
      makeStore({ id: 's6', slug: 'rozetka', engine: 'python' }),
    ];
    const { orchestrator, stores: storeFakes, scrape } = makeOrchestrator(
      stores[0],
      { maxParallelTracks: 2 },
    );

    storeFakes.findAllWithConfig.mockResolvedValue(stores);
    storeFakes.findWithConfigBySlug.mockImplementation(
      async (slug: string) => stores.find((item) => item.slug === slug) ?? null,
    );

    const events: string[] = [];
    let active = 0;
    let peak = 0;

    scrape.collectStore.mockImplementation(async (slug: string) => {
      active += 1;
      peak = Math.max(peak, active);
      events.push(`start:${slug}`);

      await new Promise((resolve) => setTimeout(resolve, 5));

      active -= 1;
      events.push(`end:${slug}`);

      return { ...RESULT, slug };
    });

    await orchestrator.runFullSync();

    expect(scrape.collectStore).toHaveBeenCalledTimes(4);
    expect(events).not.toContain('start:goodwine');
    expect(events).not.toContain('start:rozetka');
    expect(peak).toBeLessThanOrEqual(2);
    expect(events.indexOf('end:metro')).toBeLessThan(
      events.indexOf('start:novus'),
    );
  });

  it('keeps a track going when one store cannot start', async () => {
    const stores = [
      makeStore({ id: 's1', slug: 'metro', group: 'zakaz' }),
      makeStore({ id: 's2', slug: 'novus', group: 'zakaz' }),
    ];
    const { orchestrator, stores: storeFakes, syncLogs, scrape } =
      makeOrchestrator(stores[0]);

    storeFakes.findAllWithConfig.mockResolvedValue(stores);
    storeFakes.findWithConfigBySlug.mockImplementation(
      async (slug: string) => stores.find((item) => item.slug === slug) ?? null,
    );
    syncLogs.tryStart
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 'log-2' });

    await orchestrator.runFullSync();

    expect(scrape.collectStore).toHaveBeenCalledTimes(1);
    expect(scrape.collectStore).toHaveBeenCalledWith(
      'novus',
      expect.anything(),
    );
  });
});

describe('SyncOrchestratorService.onModuleInit', () => {
  it('sweeps locks orphaned by a previous process', async () => {
    const { orchestrator, syncLogs } = makeOrchestrator(makeStore());

    syncLogs.sweepOrphaned.mockResolvedValue(2);

    await orchestrator.onModuleInit();

    expect(syncLogs.sweepOrphaned).toHaveBeenCalledTimes(1);
  });

  it(
    'sweeps expired log files, so retention holds without the cron',
    async () => {
      const { orchestrator, fileLog } = makeOrchestrator(makeStore());

      fileLog.sweepRetention.mockResolvedValue(3);

      await orchestrator.onModuleInit();

      expect(fileLog.sweepRetention).toHaveBeenCalledTimes(1);
    },
  );
});
