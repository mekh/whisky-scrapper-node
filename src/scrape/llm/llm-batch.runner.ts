import { ArrayUtils } from '~utils';

/**
 * Runs a list through an LLM in batches, halving a failing batch and retrying
 * the halves so one bad answer costs one item instead of the whole batch.
 *
 * Two failures make this necessary, and both are the provider's to decide, not
 * ours. The completion budget is unpredictable: a reasoning model's chain of
 * thought scales with the batch, and an OpenRouter slug can be served by
 * several upstream providers, not all of which honour a request to stop
 * reasoning. And the answer is not always well-formed JSON — one 40-item batch
 * came back with a broken array, which under the earlier budget-only rule sent
 * all 40 names to the deterministic fallback in silence.
 */
export class LlmBatchRunner {
  /**
   * Splits `items` into batches and hands each to `handler`. A batch that
   * throws is halved and retried; a single item that still fails goes to
   * `onError` and is skipped, so one bad batch never fails the whole run.
   *
   * @param items - Items to process.
   * @param batchSize - Initial batch size.
   * @param handler - Sends one batch to the model.
   * @param onError - Reports a batch that could not be processed.
   * @param onProgress - Called after each batch with the running count. A full
   *   catalogue takes tens of minutes in which nothing else is printed, so an
   *   operator has no way to tell a slow run from a hung one.
   * @returns Resolves once every batch has been attempted.
   */
  public static async run<T>(
    items: T[],
    batchSize: number,
    handler: (batch: T[]) => Promise<void>,
    onError: (error: unknown, batch: T[]) => void,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void> {
    let done = 0;

    for (const batch of ArrayUtils.chunkify(items, batchSize)) {
      await LlmBatchRunner.attempt(batch, handler, onError);

      done += batch.length;
      onProgress?.(done, items.length);
    }
  }

  /**
   * Attempts one batch, halving it on any failure.
   *
   * @param batch - The batch to send.
   * @param handler - Sends one batch to the model.
   * @param onError - Reports a batch that could not be processed.
   * @returns Resolves once the batch (or both halves) has been attempted.
   */
  private static async attempt<T>(
    batch: T[],
    handler: (batch: T[]) => Promise<void>,
    onError: (error: unknown, batch: T[]) => void,
  ): Promise<void> {
    try {
      await handler(batch);
    } catch (error) {
      if (batch.length < 2) {
        onError(error, batch);

        return;
      }

      const half = Math.ceil(batch.length / 2);

      await LlmBatchRunner.attempt(batch.slice(0, half), handler, onError);
      await LlmBatchRunner.attempt(batch.slice(half), handler, onError);
    }
  }
}
