import 'reflect-metadata';

import OpenAI from 'openai';

import { LlmBudgetError } from '../../src/scrape/llm/llm-budget.error';
import { LlmRetryPolicy } from '../../src/scrape/llm/llm-retry-policy.util';

import type { APIError } from 'openai';

/**
 * Builds a real SDK error of the given class, since the policy classifies by
 * instance rather than by status code.
 *
 * @param status - HTTP status the response carried.
 * @param headers - Response headers, if any matter to the case.
 * @returns The error instance.
 */
function apiError(
  status: number,
  headers: Record<string, string> = {},
): APIError {
  return OpenAI.APIError.generate(
    status,
    { error: { message: 'boom' } },
    'boom',
    new Headers(headers),
  );
}

describe('LlmRetryPolicy.classify', () => {
  it('treats a rejected key as fatal', () => {
    expect(LlmRetryPolicy.classify(apiError(401))).toBe('fatal');
    expect(LlmRetryPolicy.classify(apiError(403))).toBe('fatal');
  });

  it('treats a rate limit as transport', () => {
    // Halving a rate-limited batch only doubles the requests hitting the limit.
    expect(LlmRetryPolicy.classify(apiError(429))).toBe('transport');
  });

  it('treats a provider failure as transport', () => {
    expect(LlmRetryPolicy.classify(apiError(500))).toBe('transport');
    expect(LlmRetryPolicy.classify(apiError(503))).toBe('transport');
  });

  it('treats a connection failure or timeout as transport', () => {
    const connection = new OpenAI.APIConnectionError({ message: 'socket' });
    const timeout = new OpenAI.APIConnectionTimeoutError({ message: 'slow' });

    expect(LlmRetryPolicy.classify(connection)).toBe('transport');
    expect(LlmRetryPolicy.classify(timeout)).toBe('transport');
  });

  it('halves a batch the model answered badly', () => {
    expect(LlmRetryPolicy.classify(new LlmBudgetError('cap'))).toBe('halve');
    expect(LlmRetryPolicy.classify(new SyntaxError('bad json'))).toBe('halve');
    expect(LlmRetryPolicy.classify(apiError(400))).toBe('halve');
  });

  it('halves an error it does not recognize', () => {
    // The pre-existing behaviour: an unknown provider failure costs one item.
    expect(LlmRetryPolicy.classify(new Error('who knows'))).toBe('halve');
    expect(LlmRetryPolicy.classify('a string')).toBe('halve');
  });
});

describe('LlmRetryPolicy.retryDelayMs', () => {
  it('honours the provider Retry-After header', () => {
    const error = apiError(429, { 'retry-after': '7' });

    expect(LlmRetryPolicy.retryDelayMs(error, 0)).toBe(7000);
  });

  it('backs off exponentially without a header', () => {
    const error = apiError(429);

    expect(LlmRetryPolicy.retryDelayMs(error, 0)).toBe(2000);
    expect(LlmRetryPolicy.retryDelayMs(error, 1)).toBe(4000);
  });

  it('caps the backoff', () => {
    expect(LlmRetryPolicy.retryDelayMs(apiError(429), 10)).toBe(10000);
  });

  it('caps a Retry-After long enough to outlast the run', () => {
    // A worker parked for minutes is the timeout this change exists to avoid.
    const error = apiError(429, { 'retry-after': '600' });

    expect(LlmRetryPolicy.retryDelayMs(error, 0)).toBe(10000);
  });

  it('backs off exponentially for a non-numeric header', () => {
    const error = apiError(429, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00' });

    expect(LlmRetryPolicy.retryDelayMs(error, 0)).toBe(2000);
  });

  it('backs off exponentially for an error carrying no response', () => {
    const error = new OpenAI.APIConnectionError({ message: 'socket' });

    expect(LlmRetryPolicy.retryDelayMs(error, 1)).toBe(4000);
  });
});
