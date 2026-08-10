const MS_PER_SECOND = 1000;

const SECONDS_PER_MINUTE = 60;

/**
 * Renders elapsed times for the sync log lines, which are read to explain why
 * a run took as long as it did.
 */
export class DurationUtils {
  /**
   * Formats a millisecond duration for a log line.
   *
   * @param ms - The elapsed milliseconds.
   * @returns The duration as `Ns` under a minute, `Nm SSs` above it.
   */
  public static format(ms: number): string {
    const seconds = Math.round(ms / MS_PER_SECOND);
    const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
    const rest = seconds % SECONDS_PER_MINUTE;

    if (minutes === 0) {
      return `${rest}s`;
    }

    return `${minutes}m ${String(rest).padStart(2, '0')}s`;
  }
}
