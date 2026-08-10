/**
 * Renders thrown values as text. A `catch` binding is `unknown`, and both the
 * sync-log `error` column and the log files need a string, so every such site
 * needs the same narrowing.
 */
export class ErrorUtils {
  /**
   * Renders an unknown thrown value as its message.
   *
   * @param error - The caught value.
   * @returns The error's message, or the value stringified when it is not an
   *   `Error`.
   */
  public static text(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Renders an unknown thrown value's stack trace.
   *
   * @param error - The caught value.
   * @returns The stack trace, or null when the value carries none (a thrown
   *   non-`Error`, or an `Error` whose stack was stripped).
   */
  public static stack(error: unknown): string | null {
    return error instanceof Error && error.stack ? error.stack : null;
  }
}
