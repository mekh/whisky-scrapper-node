import 'reflect-metadata';

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SyncFileLogService } from '~lib/sync-file-log';

import type { SyncConfig } from '~config';

const SECONDS_PER_DAY = 24 * 60 * 60;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whisky-log-svc-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Builds the service over the test's temp directory.
 *
 * @param over - Config overrides (`logDir`, `logRetentionDays`).
 * @returns The service.
 */
function makeService(over: Partial<SyncConfig> = {}): SyncFileLogService {
  const config = {
    logDir: dir,
    logRetentionDays: 30,
    ...over,
  } as SyncConfig;

  return new SyncFileLogService(config);
}

/**
 * Writes a file into the log directory and back-dates it.
 *
 * @param name - The file's name.
 * @param ageDays - How many days ago it was last written.
 */
function writeAged(name: string, ageDays: number): void {
  const path = join(dir, name);
  const when = Date.now() / 1000 - ageDays * SECONDS_PER_DAY;

  writeFileSync(path, 'content\n', 'utf-8');
  utimesSync(path, when, when);
}

describe('SyncFileLogService.buildFileName', () => {
  it('stamps the name and keeps the prefix', () => {
    const name = makeService().buildFileName('maudau');

    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_maudau\.log$/);
  });

  it('strips anything a name may not carry into a path', () => {
    const name = makeService().buildFileName('../etc/passwd');

    expect(name).toContain('---etc-passwd');
    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
  });

  it('returns null and touches nothing when logging is disabled', () => {
    const service = makeService({ logDir: '' });

    expect(service.buildFileName('maudau')).toBeNull();
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

describe('SyncFileLogService.open', () => {
  it('creates the directory and a writer that writes into it', async () => {
    const nested = join(dir, 'deeper');
    const config = { logDir: nested, logRetentionDays: 30 } as SyncConfig;
    const service = new SyncFileLogService(config);
    const writer = service.open('run.log');

    writer.info('hello');
    await writer.close();

    expect(existsSync(join(nested, 'run.log'))).toBe(true);
    expect(writer.fileName).toBe('run.log');
  });

  it('hands out a disabled writer for a null name', async () => {
    const writer = makeService().open(null);

    expect(writer.fileName).toBeNull();
    expect(readdirSync(dir)).toHaveLength(0);
    await writer.close();
  });
});

describe('SyncFileLogService.readLogFile', () => {
  it('reads a file the log directory holds', async () => {
    writeAged('run.log', 0);

    await expect(makeService().readLogFile('run.log')).resolves.toBe(
      'content\n',
    );
  });

  it('returns null for a file that is gone', async () => {
    await expect(makeService().readLogFile('missing.log')).resolves.toBeNull();
  });

  it('refuses a name that escapes the log directory', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'whisky-outside-'));

    writeFileSync(join(outside, 'secret.txt'), 'secret\n', 'utf-8');

    const escape = join('..', outside.split('/').pop() ?? '', 'secret.txt');

    await expect(makeService().readLogFile(escape)).resolves.toBeNull();

    rmSync(outside, { recursive: true, force: true });
  });

  it('returns null when logging is disabled', async () => {
    writeAged('run.log', 0);

    const service = makeService({ logDir: '' });

    await expect(service.readLogFile('run.log')).resolves.toBeNull();
  });
});

describe('SyncFileLogService.sweepRetention', () => {
  it('deletes the files past the window and keeps the rest', async () => {
    writeAged('old.log', 40);
    writeAged('fresh.log', 1);

    await expect(makeService().sweepRetention()).resolves.toBe(1);
    expect(existsSync(join(dir, 'old.log'))).toBe(false);
    expect(existsSync(join(dir, 'fresh.log'))).toBe(true);
  });

  it('keeps every file when the window is zero', async () => {
    writeAged('ancient.log', 400);

    const service = makeService({ logRetentionDays: 0 });

    await expect(service.sweepRetention()).resolves.toBe(0);
    expect(existsSync(join(dir, 'ancient.log'))).toBe(true);
  });

  it('does nothing when logging is disabled', async () => {
    writeAged('old.log', 40);

    const service = makeService({ logDir: '' });

    await expect(service.sweepRetention()).resolves.toBe(0);
    expect(existsSync(join(dir, 'old.log'))).toBe(true);
  });

  it('survives a log directory that does not exist yet', async () => {
    const service = makeService({ logDir: join(dir, 'not-there') });

    await expect(service.sweepRetention()).resolves.toBe(0);
  });
});
