import { Injectable, Logger } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { SyncConfig } from '~config';

import { SyncFileLogTime } from './sync-file-log-time.util';
import { SyncFileLogWriter } from './sync-file-log-writer';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Every character a log file name may contain. A store slug is already
 * restricted to these, but the name ends up in a path and in a URL, so the
 * value is filtered rather than trusted.
 */
const SAFE_NAME_CHARS = /[^a-zA-Z0-9_-]/g;

/**
 * Owns the sync log directory: names and opens a run's writer, reads a written
 * file back for the API, and deletes the files that outlived the retention
 * window.
 *
 * Nothing here throws. A sync must not fail because its log file could not be
 * written, and the API answers "no log" rather than 500 when a file is gone —
 * so every failure becomes a disabled writer, a null, or a zero, and is
 * reported to the process log instead.
 */
@Injectable()
export class SyncFileLogService {
  private readonly logger = new Logger(SyncFileLogService.name);

  private readonly config: SyncConfig;

  public constructor(config: SyncConfig) {
    this.config = config;
  }

  /**
   * Builds the name a new run's file will have, touching nothing on disk. It
   * is called before the run's `sync_log` lock is acquired, so the name can go
   * into the same insert — and so a run that loses the lock leaves no file
   * behind.
   *
   * @param prefix - What the run covers: a store slug, or `full-run`.
   * @returns The file name, or null when file logging is disabled.
   */
  public buildFileName(prefix: string): string | null {
    if (!this.config.logDir) {
      return null;
    }

    const safePrefix = prefix.replace(SAFE_NAME_CHARS, '-');

    return `${SyncFileLogTime.stamp()}_${safePrefix}.log`;
  }

  /**
   * Opens the writer for a name that {@link buildFileName} produced.
   *
   * @param fileName - The name to open, or null to get a disabled writer.
   * @returns The writer; a disabled one when logging is off or the file could
   *   not be opened.
   */
  public open(fileName: string | null): SyncFileLogWriter {
    if (!fileName || !this.config.logDir) {
      return SyncFileLogWriter.disabled();
    }

    try {
      mkdirSync(this.config.logDir, { recursive: true });

      return new SyncFileLogWriter(
        join(this.config.logDir, fileName),
        fileName,
      );
    } catch (error) {
      this.logger.warn(
        'Could not open sync log file %s: %o',
        fileName,
        error,
      );

      return SyncFileLogWriter.disabled();
    }
  }

  /**
   * Reads a run's log file back, for the API. The name comes from the
   * database, but it is still resolved and checked against the configured
   * directory — a stored value that escaped it must not turn this into an
   * arbitrary file read.
   *
   * @param fileName - The name stored on the run's `sync_log` row.
   * @returns The file's text, or null when it cannot be read.
   */
  public async readLogFile(fileName: string): Promise<string | null> {
    const filePath = this.resolveInsideLogDir(fileName);

    if (filePath === null) {
      return null;
    }

    try {
      return await readFile(filePath, 'utf-8');
    } catch (error) {
      this.logger.warn('Could not read sync log file %s: %o', fileName, error);

      return null;
    }
  }

  /**
   * Deletes the log files whose last write is older than the retention
   * window. Files accumulate one per store per run, so without this the
   * directory grows without bound — which is what the legacy Python scraper
   * did.
   *
   * @returns How many files were deleted.
   */
  public async sweepRetention(): Promise<number> {
    if (!this.config.logDir || this.config.logRetentionDays <= 0) {
      return 0;
    }

    const entries = await this.listLogDir();
    const cutoff = Date.now() - this.config.logRetentionDays * MS_PER_DAY;
    const deleted = await Promise.all(
      entries.map((entry) => this.deleteIfExpired(entry, cutoff)),
    );

    return deleted.filter(Boolean).length;
  }

  /**
   * Lists the log directory's entries.
   *
   * @returns The entry names, or an empty list when the directory cannot be
   *   read (including when it does not exist yet).
   */
  private async listLogDir(): Promise<string[]> {
    try {
      return await readdir(this.config.logDir);
    } catch (error) {
      this.logger.warn(
        'Could not list the sync log directory %s: %o',
        this.config.logDir,
        error,
      );

      return [];
    }
  }

  /**
   * Deletes one entry when it is a file last written before the cutoff.
   *
   * @param entry - The entry's name inside the log directory.
   * @param cutoff - Epoch milliseconds a file must have been written after to
   *   survive.
   * @returns True when the entry was deleted.
   */
  private async deleteIfExpired(
    entry: string,
    cutoff: number,
  ): Promise<boolean> {
    const filePath = join(this.config.logDir, entry);

    try {
      const stats = await stat(filePath);

      if (!stats.isFile() || stats.mtimeMs >= cutoff) {
        return false;
      }

      await unlink(filePath);

      return true;
    } catch (error) {
      this.logger.warn(
        'Could not expire the sync log file %s: %o',
        filePath,
        error,
      );

      return false;
    }
  }

  /**
   * Resolves a file name against the log directory, refusing anything that
   * lands outside it.
   *
   * @param fileName - The name to resolve.
   * @returns The absolute path, or null when logging is disabled or the name
   *   escapes the directory.
   */
  private resolveInsideLogDir(fileName: string): string | null {
    if (!this.config.logDir) {
      return null;
    }

    const dir = resolve(this.config.logDir);
    const filePath = resolve(dir, fileName);

    if (!filePath.startsWith(dir + sep)) {
      this.logger.warn(
        'Refused to read the sync log file %s: outside %s',
        fileName,
        dir,
      );

      return null;
    }

    return filePath;
  }
}
