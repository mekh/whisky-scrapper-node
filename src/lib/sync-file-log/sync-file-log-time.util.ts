/**
 * Time formatting for sync log files: the per-line clock and the timestamp a
 * file name starts with.
 *
 * Both read the process's own local time zone (`TZ`, UTC when unset), and
 * deliberately not `SyncConfig.timezone` — that setting only decides when the
 * cron fires. Using it here would let a file's own lines disagree with the
 * mtime the retention sweep judges it by.
 */
export class SyncFileLogTime {
  /**
   * Formats the wall clock for a log line.
   *
   * @param date - The moment to render; defaults to now.
   * @returns The time as `HH:MM:SS`.
   */
  public static clock(date: Date = new Date()): string {
    return [date.getHours(), date.getMinutes(), date.getSeconds()]
      .map((value) => this.pad(value))
      .join(':');
  }

  /**
   * Formats the timestamp a log file name starts with. Sorts
   * chronologically as text, and carries no character that needs escaping in
   * a path or a URL.
   *
   * @param date - The moment to render; defaults to now.
   * @returns The timestamp as `YYYY-MM-DD_HH-MM-SS`.
   */
  public static stamp(date: Date = new Date()): string {
    const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
      .map((value) => this.pad(value))
      .join('-');
    const time = this.clock(date).replace(/:/g, '-');

    return `${day}_${time}`;
  }

  /**
   * Left-pads a date part to two digits.
   *
   * @param value - The part to pad.
   * @returns The part as a two-character string.
   */
  private static pad(value: number): string {
    return String(value).padStart(2, '0');
  }
}
