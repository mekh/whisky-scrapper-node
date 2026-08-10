import { Logger } from '@nestjs/common';
import { WriteStream, createWriteStream } from 'node:fs';

import type { SyncFileLogLevel } from '~types';

import { SyncFileLogTime } from './sync-file-log-time.util';

/**
 * Width the level name is padded to, so the message column lines up whichever
 * level a line carries.
 */
const LEVEL_WIDTH = 7;

/**
 * How long `close` waits for the stream to flush before giving up on it. A
 * wedged file must not hold up the sync that was writing to it.
 */
const CLOSE_TIMEOUT_MS = 2000;

/**
 * Appends the lines of one sync run to its own log file.
 *
 * Everything here is best effort: a write is never allowed to fail or slow the
 * sync it describes, so the first stream error disables the writer instead of
 * propagating, and every later write is dropped silently.
 *
 * `close` is idempotent and flips the `closed` flag synchronously, before it
 * awaits anything. That is what makes the timeout path safe: a timed-out
 * collection is abandoned rather than aborted, so it keeps emitting progress
 * events after its run was finalized, and those events must land nowhere
 * rather than on a file that has already been closed (or, worse, reopened by
 * the next run).
 */
export class SyncFileLogWriter {
  /**
   * Builds a writer with no file behind it, which discards every line. Used
   * when file logging is off or the file could not be opened, so no caller
   * has to branch on whether logging is actually active.
   *
   * @returns A writer that does nothing.
   */
  public static disabled(): SyncFileLogWriter {
    return new SyncFileLogWriter(null, null);
  }

  /**
   * The file's name, or null when this writer discards its input. Stored on
   * the run's `sync_log` row, which is how the read endpoint finds the file
   * again.
   */
  public readonly fileName: string | null;

  private readonly logger = new Logger(SyncFileLogWriter.name);

  private stream: WriteStream | null;

  private failed = false;

  private closed = false;

  public constructor(filePath: string | null, fileName: string | null) {
    this.fileName = fileName;
    this.stream = filePath === null
      ? null
      : createWriteStream(filePath, { flags: 'a' });

    this.stream?.on('error', (error: unknown) => {
      this.disable(error);
    });
  }

  /**
   * Writes the run's opening line.
   *
   * @param message - What the run is about to do.
   */
  public header(message: string): void {
    this.write('INFO', `=== ${message} ===`);
  }

  /**
   * Writes the run's closing line.
   *
   * @param message - How the run ended.
   * @param level - Severity of the outcome; `INFO` unless something failed.
   */
  public footer(message: string, level: SyncFileLogLevel = 'INFO'): void {
    this.write(level, `=== ${message} ===`);
  }

  /**
   * Writes a milestone line.
   *
   * @param message - The line's text.
   */
  public info(message: string): void {
    this.write('INFO', message);
  }

  /**
   * Writes a per-page or per-batch detail line.
   *
   * @param message - The line's text.
   */
  public debug(message: string): void {
    this.write('DEBUG', message);
  }

  /**
   * Writes a line about something the run survived.
   *
   * @param message - The line's text.
   */
  public warn(message: string): void {
    this.write('WARNING', message);
  }

  /**
   * Writes a line about something that failed.
   *
   * @param message - The line's text.
   */
  public error(message: string): void {
    this.write('ERROR', message);
  }

  /**
   * Flushes and closes the file. Safe to call more than once, and on a writer
   * that never had a file. Always settles, even when the stream does not
   * report back, so a sync can never hang on its own log file.
   *
   * @returns Resolves once the file is closed or the wait timed out.
   */
  public async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;

    const stream = this.stream;

    this.stream = null;

    if (!stream || stream.destroyed) {
      return;
    }

    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);

      /**
       * The timer must not keep the process alive on shutdown, and a stream
       * that errors while flushing never reaches `finish`.
       */
      timer.unref();
      stream.once('error', () => {
        clearTimeout(timer);
        resolve();
      });
      stream.end(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Formats and appends one line, unless this writer is closed, disabled, or
   * has no file.
   *
   * @param level - The line's severity.
   * @param message - The line's text.
   */
  private write(level: SyncFileLogLevel, message: string): void {
    if (this.closed || this.failed || !this.stream) {
      return;
    }

    const line = `${SyncFileLogTime.clock()} ${level.padEnd(LEVEL_WIDTH)} `
      + `${message}\n`;

    try {
      this.stream.write(line);
    } catch (error) {
      this.disable(error);
    }
  }

  /**
   * Gives up on the file after a write failure, reporting it once to the
   * process log — where it is visible without the file this writer can no
   * longer produce.
   *
   * @param error - What the stream reported.
   */
  private disable(error: unknown): void {
    if (this.failed) {
      return;
    }

    this.failed = true;

    this.logger.warn(
      'Sync log file %s failed, dropping its remaining lines: %o',
      this.fileName,
      error,
    );
  }
}
