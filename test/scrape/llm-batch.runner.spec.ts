import 'reflect-metadata';

import { LlmBatchRunner } from '../../src/scrape/llm/llm-batch.runner';
import { LlmBudgetError } from '../../src/scrape/llm/llm-budget.error';

const items = (count: number): number[] =>
  Array.from({ length: count }, (_, i) => i);

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
});
