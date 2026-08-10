import OpenAI from 'openai';

import type { LlmErrorKind } from './llm.interfaces';

const BASE_DELAY_MS = 2000;

const MAX_DELAY_MS = 10000;

/**
 * The one header lookup this policy needs. Declared here because the global
 * fetch `Headers` type is outside this project's lib set, which leaves the
 * SDK's own header field typed as `any`. Used nowhere else.
 */
interface HeaderReader {
  /**
   * Returns a header's value, or null when the response did not carry it.
   */
  get(name: string): string | null;
}

/**
 * Decides what a failed LLM call means and how long to wait before repeating
 * it, so `LlmBatchRunner` never has to know an OpenAI SDK error shape itself.
 *
 * The distinction that matters is transport versus content. Splitting a batch
 * in half is the right answer to an answer the model got wrong — a completion
 * budget spent on reasoning, a malformed array — because the halves are smaller
 * questions. It is the wrong answer to a rate limit or a provider outage: the
 * batch was never the problem, and halving it only doubles the number of
 * requests aimed at whatever is already refusing them.
 */
export class LlmRetryPolicy {
  /**
   * Classifies a batch failure.
   *
   * `fatal` (a rejected key, a model the key may not use) means every
   * remaining batch would fail the same way, so the run stops instead of
   * spending the whole budget rediscovering it one batch at a time.
   * `transport` is retried at the same size. Everything else — including an
   * unrecognized error — keeps today's halving behaviour, so a provider
   * failure this policy has not seen before degrades exactly as it used to.
   *
   * @param error - The error the batch handler rejected with.
   * @returns How the runner should treat it.
   */
  public static classify(error: unknown): LlmErrorKind {
    if (
      error instanceof OpenAI.AuthenticationError
      || error instanceof OpenAI.PermissionDeniedError
    ) {
      return 'fatal';
    }

    /**
     * `APIConnectionTimeoutError` extends `APIConnectionError`, so the
     * configured per-call timeout is covered here too.
     */
    if (
      error instanceof OpenAI.RateLimitError
      || error instanceof OpenAI.InternalServerError
      || error instanceof OpenAI.APIConnectionError
    ) {
      return 'transport';
    }

    return 'halve';
  }

  /**
   * How long to hold off before re-sending a transport-failed batch: the
   * provider's own `Retry-After` when it sent one, otherwise exponential
   * backoff.
   *
   * Both are capped at the same ceiling, `Retry-After` included. A provider
   * asking for minutes would otherwise park a worker well past the run's own
   * LLM deadline, which is the failure this whole pass was made to avoid — and
   * a batch that still gets refused after the cap simply keeps its items for
   * the next run, which costs nothing.
   *
   * @param error - The transport error just caught.
   * @param round - Same-batch retries already spent, zero-based.
   * @returns The delay in milliseconds.
   */
  public static retryDelayMs(error: unknown, round: number): number {
    const retryAfter = LlmRetryPolicy.retryAfterMs(error);

    if (retryAfter !== null) {
      return Math.min(MAX_DELAY_MS, retryAfter);
    }

    return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** round);
  }

  /**
   * Reads the `Retry-After` header (seconds) off an API error, when the
   * response carried one. Connection-level errors have no response and so no
   * headers at all.
   *
   * @param error - The error to inspect.
   * @returns The delay in milliseconds, or null when no usable header was sent.
   */
  private static retryAfterMs(error: unknown): number | null {
    if (!(error instanceof OpenAI.APIError)) {
      return null;
    }

    const headers = error.headers as HeaderReader | undefined;
    const header = headers?.get('retry-after');
    const seconds = header === null || header === undefined
      ? Number.NaN
      : Number(header);

    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }
}
