import 'reflect-metadata';

import { NotFoundError } from '~errors';

import { StoreService } from '../../src/domain/store/store.service';

import type { CoreProductService } from '~core/product';
import type { CoreStoreService } from '~core/store';
import type { CoreSyncLogService } from '~core/sync-log';
import type { SyncFileLogService } from '~lib/sync-file-log';
import type { EntitySyncLog, StoreListItem } from '~types';
import type {
  SyncOrchestratorService,
} from '../../src/domain/store/sync-orchestrator.service';

interface Fakes {
  /**
   * The service under test.
   */
  service: StoreService;

  /**
   * Store lookups.
   */
  stores: { [key: string]: jest.Mock };

  /**
   * Sync-log lookups.
   */
  syncLogs: { [key: string]: jest.Mock };

  /**
   * The file-log service stub.
   */
  fileLog: { [key: string]: jest.Mock };
}

const STORE = {
  id: 'store-1',
  slug: 'maudau',
  name: 'MauDau',
} as StoreListItem;

const LOG = {
  id: 'log-1',
  storeId: 'store-1',
  logFile: '2026-08-10_12-00-05_maudau.log',
} as EntitySyncLog;

/**
 * Wires the service with jest fakes for the dependencies `syncLogFile` uses.
 *
 * @param store - What `findWithConfigBySlug` resolves to.
 * @param log - What `findById` resolves to.
 * @param content - What the file read returns.
 * @returns The service plus its fakes.
 */
function makeService(
  store: StoreListItem | null,
  log: EntitySyncLog | null,
  content: string | null = 'log content\n',
): Fakes {
  const stores = {
    findWithConfigBySlug: jest.fn().mockResolvedValue(store),
  };
  const syncLogs = {
    findById: jest.fn().mockResolvedValue(log),
  };
  const fileLog = {
    readLogFile: jest.fn().mockResolvedValue(content),
  };
  const service = new StoreService(
    stores as unknown as CoreStoreService,
    {} as CoreProductService,
    syncLogs as unknown as CoreSyncLogService,
    {} as SyncOrchestratorService,
    fileLog as unknown as SyncFileLogService,
  );

  return { service, stores, syncLogs, fileLog };
}

describe('StoreService.syncLogFile', () => {
  it('returns the file content of the store run', async () => {
    const { service, fileLog } = makeService(STORE, LOG);

    await expect(service.syncLogFile('maudau', 'log-1')).resolves.toBe(
      'log content\n',
    );
    expect(fileLog.readLogFile).toHaveBeenCalledWith(
      '2026-08-10_12-00-05_maudau.log',
    );
  });

  it('404s an unknown store without looking for a file', async () => {
    const { service, syncLogs, fileLog } = makeService(null, LOG);

    await expect(service.syncLogFile('nope', 'log-1'))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(syncLogs.findById).not.toHaveBeenCalled();
    expect(fileLog.readLogFile).not.toHaveBeenCalled();
  });

  it('404s a missing sync-log row', async () => {
    const { service, fileLog } = makeService(STORE, null);

    await expect(service.syncLogFile('maudau', 'log-9'))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(fileLog.readLogFile).not.toHaveBeenCalled();
  });

  it('404s a row that belongs to another store', async () => {
    const { service, fileLog } = makeService(
      STORE,
      { ...LOG, storeId: 'store-2' } as EntitySyncLog,
    );

    await expect(service.syncLogFile('maudau', 'log-1'))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(fileLog.readLogFile).not.toHaveBeenCalled();
  });

  it('404s a run that wrote no file', async () => {
    const { service, fileLog } = makeService(
      STORE,
      { ...LOG, logFile: undefined } as EntitySyncLog,
    );

    await expect(service.syncLogFile('maudau', 'log-1'))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(fileLog.readLogFile).not.toHaveBeenCalled();
  });

  it('404s when the file is gone, expired or unreadable', async () => {
    const { service } = makeService(STORE, LOG, null);

    await expect(service.syncLogFile('maudau', 'log-1'))
      .rejects.toBeInstanceOf(NotFoundError);
  });
});
