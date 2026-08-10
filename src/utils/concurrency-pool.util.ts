/**
 * Runs a list of items through an async worker with a cap on how many run at
 * once.
 *
 * It exists for the LLM passes, whose batches used to be sent strictly one
 * after another: a store's ~800 pending items are twenty batches, and at a few
 * seconds each that alone outgrew the sync's whole time budget while the
 * provider sat idle between calls.
 */
export class ConcurrencyPool {
  /**
   * Calls `worker` once per item, keeping at most `concurrency` calls in
   * flight. Items are claimed in list order but may finish in any order.
   *
   * `worker` must not reject: the spawned loops are awaited as one, so a
   * rejection abandons every other in-flight call. A caller that needs
   * per-item error handling catches inside the worker.
   *
   * @param queue - Items to process.
   * @param concurrency - Maximum concurrent calls, clamped to at least one and
   *   to the queue length.
   * @param worker - Called with each item and its index in `queue`.
   * @returns Resolves once every item has been processed.
   */
  public static async run<T>(
    queue: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<void>,
  ): Promise<void> {
    let cursor = 0;

    const size = Math.max(1, Math.min(concurrency, queue.length));

    const spawn = async (): Promise<void> => {
      while (cursor < queue.length) {
        const index = cursor;

        cursor += 1;

        await worker(queue[index], index);
      }
    };

    await Promise.all(Array.from({ length: size }, () => spawn()));
  }
}
