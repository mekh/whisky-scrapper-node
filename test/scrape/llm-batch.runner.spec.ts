import 'reflect-metadata';

import OpenAI from 'openai';

import { LlmBatchRunner } from '../../src/scrape/llm/llm-batch.runner';
import { LlmBudgetError } from '../../src/scrape/llm/llm-budget.error';
import { LlmDeadlineError } from '../../src/scrape/llm/llm-deadline.error';

import type { APIError } from 'openai';

const items = (count: number): number[] =>
  Array.from({ length: count }, (_, i) => i);

/**
 * Builds a real SDK error, which is what the retry policy classifies on.
 *
 * @param status - HTTP status the response carried.
 * @returns The error instance.
 */
function apiError(status: number): APIError {
  return OpenAI.APIError.generate(status, undefined, 'boom', new Headers());
}

/**
 * An already-fired deadline, for the skip paths.
 *
 * @returns An aborted signal.
 */
function aborted(): AbortSignal {
  const controller = new AbortController();

  controller.abort();

  return controller.signal;
}

describe('LlmBatchRunner.run', () => {
  it('splits the list into batches of the given size', async () => {
    const seen: number[][] = [];

    await LlmBatchRunner.run(items(85), 40, (batch) => {
      seen.push(batch);

      return Promise.resolve();
    }, () => undefined);

    expect(seen.map((b) => b.length)).toEqual([40, 40, 5]);
  });

  it(
    'halves a batch that ran out of budget and retries the halves',
    async () => {
      const sizes: number[] = [];

      await LlmBatchRunner.run(items(8), 8, (batch) => {
        sizes.push(batch.length);

        return batch.length > 2
          ? Promise.reject(new LlmBudgetError('cap'))
          : Promise.resolve();
      }, () => undefined);

      // 8 fails -> 4 + 4, each fails -> 2 + 2 twice, all four succeed.
      expect(sizes).toEqual([8, 4, 2, 2, 4, 2, 2]);
    },
  );

  it('reports a single item that still does not fit', async () => {
    const failures: number[] = [];

    await LlmBatchRunner.run(
      items(2),
      2,
      () => Promise.reject(new LlmBudgetError('cap')),
      (_error, batch) => failures.push(batch.length),
    );

    expect(failures).toEqual([1, 1]);
  });

  it('halves a malformed answer down to the failing item', async () => {
    // A broken JSON array used to cost the whole batch its extracted names.
    const failures: number[] = [];

    await LlmBatchRunner.run(
      items(8),
      8,
      (batch) =>
        batch.includes(3)
          ? Promise.reject(new SyntaxError("Expected ',' or ']'"))
          : Promise.resolve(),
      (_error, batch) => failures.push(batch.length),
    );

    expect(failures).toEqual([1]);
  });

  it('keeps mutations made to the items of a retried batch', async () => {
    const list = [{ n: 1, done: false }, { n: 2, done: false }];

    await LlmBatchRunner.run(list, 2, (batch) => {
      if (batch.length > 1) {
        return Promise.reject(new LlmBudgetError('cap'));
      }

      batch.forEach((item) => {
        item.done = true;
      });

      return Promise.resolve();
    }, () => undefined);

    expect(list.every((item) => item.done)).toBe(true);
  });

  it('reports progress after each batch', () => {
    const seen: [number, number][] = [];

    return LlmBatchRunner.run(
      items(85),
      40,
      () => Promise.resolve(),
      () => undefined,
      (done, total) => seen.push([done, total]),
    ).then(() => {
      expect(seen).toEqual([[40, 85], [80, 85], [85, 85]]);
    });
  });

  it('sends one batch at a time by default', async () => {
    let live = 0;
    let peak = 0;

    await LlmBatchRunner.run(items(120), 40, async () => {
      live += 1;
      peak = Math.max(peak, live);

      await Promise.resolve();

      live -= 1;
    }, () => undefined);

    expect(peak).toBe(1);
  });

  it('sends batches concurrently up to the configured cap', async () => {
    let live = 0;
    let peak = 0;

    await LlmBatchRunner.run(
      items(200),
      40,
      async () => {
        live += 1;
        peak = Math.max(peak, live);

        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1);
        });

        live -= 1;
      },
      () => undefined,
      undefined,
      { concurrency: 3 },
    );

    expect(peak).toBe(3);
  });

  it('counts every item exactly once under concurrency', async () => {
    const seen: number[] = [];

    await LlmBatchRunner.run(
      items(85),
      40,
      (batch) => {
        seen.push(...batch);

        return Promise.resolve();
      },
      () => undefined,
      undefined,
      { concurrency: 3 },
    );

    expect([...seen].sort((a, b) => a - b)).toEqual(items(85));
  });

  it('grows the progress count monotonically to the total', async () => {
    const seen: number[] = [];

    await LlmBatchRunner.run(
      items(85),
      40,
      () => Promise.resolve(),
      () => undefined,
      (done) => seen.push(done),
      { concurrency: 3 },
    );

    expect(seen.at(-1)).toBe(85);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('retries a rate-limited batch whole rather than halving it', async () => {
    // Halving a rate-limited batch aims twice as many requests at the limit.
    const sizes: number[] = [];
    let attempts = 0;

    await LlmBatchRunner.run(items(8), 8, (batch) => {
      sizes.push(batch.length);
      attempts += 1;

      return attempts === 1
        ? Promise.reject(apiError(429))
        : Promise.resolve();
    }, () => undefined);

    expect(sizes).toEqual([8, 8]);
  });

  it('gives up on a transport failure without halving', async () => {
    const failures: number[] = [];
    const sizes: number[] = [];

    await LlmBatchRunner.run(
      items(8),
      8,
      (batch) => {
        sizes.push(batch.length);

        return Promise.reject(apiError(503));
      },
      (_error, batch) => failures.push(batch.length),
    );

    expect(sizes).toEqual([8, 8]);
    expect(failures).toEqual([8]);
  });

  it('stops the run on an error every batch would hit', async () => {
    // A rejected key fails every batch, so spending the budget on it is waste.
    const sizes: number[] = [];
    const failures: unknown[] = [];

    await LlmBatchRunner.run(
      items(120),
      40,
      (batch) => {
        sizes.push(batch.length);

        return Promise.reject(apiError(401));
      },
      (error) => failures.push(error),
    );

    expect(sizes).toEqual([40]);
    expect(failures).toHaveLength(3);
    expect(failures.slice(1)).toEqual([
      expect.any(LlmDeadlineError),
      expect.any(LlmDeadlineError),
    ]);
  });

  it('skips every batch once the deadline has fired', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const failures: unknown[] = [];

    await LlmBatchRunner.run(
      items(85),
      40,
      handler,
      (error) => failures.push(error),
      undefined,
      { signal: aborted() },
    );

    expect(handler).not.toHaveBeenCalled();
    expect(failures).toEqual([
      expect.any(LlmDeadlineError),
      expect.any(LlmDeadlineError),
      expect.any(LlmDeadlineError),
    ]);
  });

  it('reports full progress even for skipped batches', async () => {
    const seen: number[] = [];

    await LlmBatchRunner.run(
      items(85),
      40,
      () => Promise.resolve(),
      () => undefined,
      (done) => seen.push(done),
      { signal: aborted() },
    );

    expect(seen.at(-1)).toBe(85);
  });

  it('lets a batch already in flight finish past the deadline', async () => {
    const controller = new AbortController();
    const finished: number[] = [];

    await LlmBatchRunner.run(
      items(80),
      40,
      async (batch) => {
        controller.abort();
        await Promise.resolve();
        finished.push(batch.length);
      },
      () => undefined,
      undefined,
      { signal: controller.signal },
    );

    // The first batch was already paid for; only the second is skipped.
    expect(finished).toEqual([40]);
  });
});
