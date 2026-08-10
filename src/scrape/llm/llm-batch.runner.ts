import { ArrayUtils, ConcurrencyPool } from '~utils';

import { LlmDeadlineError } from './llm-deadline.error';
import { LlmRetryPolicy } from './llm-retry-policy.util';

import type { LlmRunOptions } from './llm.interfaces';

const DEFAULT_CONCURRENCY = 1;

/**
 * How many times a transport-failed batch is re-sent at its original size
 * before it is given up on. One round: the SDK has already retried the call
 * itself by the time the error reaches here, so this exists mainly to let the
 * whole pool pause and try once more after the provider has had a breather.
 */
const TRANSPORT_RETRY_ROUNDS = 1;

const DEADLINE_MESSAGE =
  "Skipped: the run's LLM budget elapsed before this batch was sent";

const ABORTED_MESSAGE =
  'Skipped: an earlier batch failed for a reason every batch would hit';

/**
 * Mutable state shared by every worker of one `run` call. Local to this file
 * and never handed out, so it is declared here rather than in the module's
 * interfaces.
 */
interface LlmRunState {
  /**
   * Items accounted for so far, which is what `onProgress` reports.
   */
  done: number;

  /**
   * True once the run stopped taking new batches.
   */
  aborted: boolean;

  /**
   * Epoch milliseconds before which no worker may send. Raised by a rate-limit
   * or server error so the whole pool backs off together instead of each
   * worker discovering the same limit on its own.
   */
  backoffUntil: number;
}

/**
 * Runs a list through an LLM in batches, several at a time, and decides what to
 * do with a batch the provider did not answer.
 *
 * Two failures make the retry policy necessary, and both are the provider's to
 * decide, not ours. The completion budget is unpredictable: a reasoning model's
 * chain of thought scales with the batch, and an OpenRouter slug can be served
 * by several upstream providers, not all of which honour a request to stop
 * reasoning. And the answer is not always well-formed JSON — one 40-item batch
 * came back with a broken array, which under the earlier budget-only rule sent
 * all 40 names to the deterministic fallback in silence. So a batch the model
 * answered badly is halved, down to a single item if need be, and costs one
 * item rather than forty.
 *
 * A batch the provider never answered at all is the opposite case: a 429 or a
 * 5xx says nothing about the batch, and halving it would aim twice as many
 * requests at whatever is already refusing them. Those are re-sent whole, after
 * a pause the whole pool observes.
 */
export class LlmBatchRunner {
  /**
   * Splits `items` into batches and hands each to `handler`, keeping up to
   * `options.concurrency` of them in flight. A batch that fails is retried or
   * halved per {@link LlmRetryPolicy}; one that cannot be processed goes to
   * `onError` and is skipped, so no single batch ever fails the whole run.
   *
   * @param items - Items to process.
   * @param batchSize - Initial batch size.
   * @param handler - Sends one batch to the model.
   * @param onError - Reports a batch that could not be processed.
   * @param onProgress - Called after each batch with the running count. A full
   *   catalogue takes tens of minutes in which nothing else is printed, so an
   *   operator has no way to tell a slow run from a hung one. Under
   *   concurrency the count still only grows, but the batches it counts no
   *   longer arrive in list order.
   * @param options - Concurrency cap and cooperative deadline.
   * @returns Resolves once every batch has been attempted or skipped.
   */
  public static async run<T>(
    items: T[],
    batchSize: number,
    handler: (batch: T[]) => Promise<void>,
    onError: (error: unknown, batch: T[]) => void,
    onProgress?: (done: number, total: number) => void,
    options: LlmRunOptions = {},
  ): Promise<void> {
    const batches = ArrayUtils.chunkify(items, batchSize);
    const state: LlmRunState = { done: 0, aborted: false, backoffUntil: 0 };
    const concurrency = Math.max(
      1,
      options.concurrency ?? DEFAULT_CONCURRENCY,
    );

    await ConcurrencyPool.run(
      batches,
      concurrency,
      async (batch: T[]): Promise<void> => {
        await LlmBatchRunner.take(batch, handler, onError, state, options);

        state.done += batch.length;
        onProgress?.(state.done, items.length);
      },
    );
  }

  /**
   * Picks up one batch, unless the run has already stopped taking work.
   *
   * @param batch - The batch a worker just claimed.
   * @param handler - Sends one batch to the model.
   * @param onError - Reports a batch that could not be processed.
   * @param state - The run's shared state.
   * @param options - The run's options, read for the deadline.
   * @returns Resolves once the batch has been attempted or reported skipped.
   */
  private static async take<T>(
    batch: T[],
    handler: (batch: T[]) => Promise<void>,
    onError: (error: unknown, batch: T[]) => void,
    state: LlmRunState,
    options: LlmRunOptions,
  ): Promise<void> {
    if (options.signal?.aborted === true) {
      onError(new LlmDeadlineError(DEADLINE_MESSAGE), batch);

      return;
    }

    if (state.aborted) {
      onError(new LlmDeadlineError(ABORTED_MESSAGE), batch);

      return;
    }

    await LlmBatchRunner.attempt(batch, handler, onError, state);
  }

  /**
   * Attempts one batch, retrying it whole on a transport failure and halving
   * it on a content one. Never throws.
   *
   * @param batch - The batch to send.
   * @param handler - Sends one batch to the model.
   * @param onError - Reports a batch that could not be processed.
   * @param state - The run's shared state.
   * @returns Resolves once the batch (or every half of it) has been attempted.
   */
  private static async attempt<T>(
    batch: T[],
    handler: (batch: T[]) => Promise<void>,
    onError: (error: unknown, batch: T[]) => void,
    state: LlmRunState,
  ): Promise<void> {
    let round = 0;

    for (;;) {
      await LlmBatchRunner.waitOutBackoff(state);

      try {
        await handler(batch);

        return;
      } catch (error) {
        const kind = LlmRetryPolicy.classify(error);

        if (kind === 'fatal') {
          state.aborted = true;
          onError(error, batch);

          return;
        }

        if (kind === 'transport' && round < TRANSPORT_RETRY_ROUNDS) {
          LlmBatchRunner.backOff(error, round, state);
          round += 1;

          continue;
        }

        if (kind === 'transport' || batch.length < 2) {
          onError(error, batch);

          return;
        }

        await LlmBatchRunner.halve(batch, handler, onError, state);

        return;
      }
    }
  }

  /**
   * Retries a batch as two halves, one after the other and inside the worker
   * slot that discovered the failure. A batch that keeps splitting must not fan
   * out into more concurrent requests than the pool was given — the point of
   * halving is to spend fewer items per answer, not more requests.
   *
   * @param batch - The batch to split.
   * @param handler - Sends one batch to the model.
   * @param onError - Reports a batch that could not be processed.
   * @param state - The run's shared state.
   * @returns Resolves once both halves have been attempted.
   */
  private static async halve<T>(
    batch: T[],
    handler: (batch: T[]) => Promise<void>,
    onError: (error: unknown, batch: T[]) => void,
    state: LlmRunState,
  ): Promise<void> {
    const half = Math.ceil(batch.length / 2);

    await LlmBatchRunner.attempt(batch.slice(0, half), handler, onError, state);
    await LlmBatchRunner.attempt(batch.slice(half), handler, onError, state);
  }

  /**
   * Waits until the pool-wide backoff gate has passed.
   *
   * @param state - The run's shared state.
   * @returns Resolves once sending is allowed again.
   */
  private static async waitOutBackoff(state: LlmRunState): Promise<void> {
    const wait = state.backoffUntil - Date.now();

    if (wait <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, wait);
    });
  }

  /**
   * Pushes the pool-wide backoff gate out past this failure's delay. Every
   * worker consults the gate before its next send, so one rate limit pauses the
   * whole pass rather than each batch running into it separately.
   *
   * @param error - The transport error just caught.
   * @param round - Same-batch retries already spent, zero-based.
   * @param state - The run's shared state.
   */
  private static backOff(
    error: unknown,
    round: number,
    state: LlmRunState,
  ): void {
    const delay = LlmRetryPolicy.retryDelayMs(error, round);

    state.backoffUntil = Math.max(state.backoffUntil, Date.now() + delay);
  }
}
