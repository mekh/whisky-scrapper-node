/**
 * Bounds a wait that would otherwise be the dependency's to decide.
 *
 * Every external call in this application is bounded, because a default of
 * "wait forever" turns one dependency's bad minute into an unbounded outage
 * of everything — which is what it cost on 2026-08-30.
 */
export class DeadlineUtils {
  /**
   * Races a promise against a deadline of its own.
   *
   * @param command - The operation already in flight.
   * @param deadlineMs - How long to wait for it.
   * @returns The operation's result.
   * @throws {Error} When the deadline passes first.
   */
  public static async bounded<T>(
    command: Promise<T>,
    deadlineMs: number,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;

    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`timed out after ${deadlineMs} ms`));
      }, deadlineMs);

      timer.unref();
    });

    try {
      return await Promise.race([command, deadline]);
    } finally {
      clearTimeout(timer);

      /**
       * When the deadline won, the command is still in flight and may still
       * reject; without a handler that would surface as an unhandled
       * rejection and, depending on the runtime's settings, end the process.
       */
      command.catch(() => undefined);
    }
  }
}
