import 'reflect-metadata';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SyncFileLogWriter } from '~lib/sync-file-log';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whisky-log-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Opens a writer over a fresh file in the test's temp directory.
 *
 * @param name - The file's name.
 * @returns The writer and the absolute path it writes to.
 */
function open(name = 'run.log'): {
  writer: SyncFileLogWriter;
  path: string;
} {
  const path = join(dir, name);

  return { writer: new SyncFileLogWriter(path, name), path };
}

describe('SyncFileLogWriter', () => {
  it('writes one padded, timestamped line per call', async () => {
    const { writer, path } = open();

    writer.header('Sync started for maudau');
    writer.info('Listing fetched: 10 item(s)');
    writer.debug('Page 1: 4 new');
    writer.warn('Detail fetch failed');
    writer.error('Sync failed');
    writer.footer('Sync finished', 'ERROR');

    await writer.close();

    const lines = readFileSync(path, 'utf-8').trimEnd().split('\n');

    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(
      /^\d{2}:\d{2}:\d{2} INFO {4}=== Sync started for maudau ===$/,
    );
    expect(lines[1]).toMatch(/^\d{2}:\d{2}:\d{2} INFO {4}Listing fetched/);
    expect(lines[2]).toMatch(/^\d{2}:\d{2}:\d{2} DEBUG {3}Page 1: 4 new$/);
    expect(lines[3]).toMatch(/^\d{2}:\d{2}:\d{2} WARNING Detail fetch failed$/);
    expect(lines[4]).toMatch(/^\d{2}:\d{2}:\d{2} ERROR {3}Sync failed$/);
    expect(lines[5]).toContain('ERROR   === Sync finished ===');
  });

  it('appends to an existing file instead of truncating it', async () => {
    const first = open();

    first.writer.info('first run');
    await first.writer.close();

    const second = open();

    second.writer.info('second run');
    await second.writer.close();

    const content = readFileSync(second.path, 'utf-8');

    expect(content).toContain('first run');
    expect(content).toContain('second run');
  });

  it('reports the file name it was opened with', () => {
    const { writer } = open('2026-08-10_12-00-05_maudau.log');

    expect(writer.fileName).toBe('2026-08-10_12-00-05_maudau.log');
  });

  it('drops the lines a timed-out run writes after close', async () => {
    const { writer, path } = open();

    writer.info('before close');
    await writer.close();

    expect(() => {
      writer.info('after close');
    }).not.toThrow();

    const content = readFileSync(path, 'utf-8');

    expect(content).toContain('before close');
    expect(content).not.toContain('after close');
  });

  it('closes only once, however often it is called', async () => {
    const { writer } = open();

    await writer.close();
    await expect(writer.close()).resolves.toBeUndefined();
  });

  it('keeps going when the file cannot be written', async () => {
    const { writer } = open();

    /**
     * What a full disk or a revoked permission looks like from here: the
     * stream reports an error, and every later line has to be dropped rather
     * than thrown at the sync.
     */
    writer.info('before the failure');
    (writer as unknown as { stream: { emit: (e: string, v: Error) => void } })
      .stream
      .emit('error', new Error('ENOSPC'));

    expect(() => {
      writer.info('after the failure');
    }).not.toThrow();
    await expect(writer.close()).resolves.toBeUndefined();
  });

  it('a disabled writer accepts every call and names no file', async () => {
    const writer = SyncFileLogWriter.disabled();

    expect(writer.fileName).toBeNull();
    expect(() => {
      writer.header('nothing');
      writer.info('nothing');
      writer.error('nothing');
      writer.footer('nothing');
    }).not.toThrow();
    await expect(writer.close()).resolves.toBeUndefined();
  });
});
