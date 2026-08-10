import { ConcurrencyPool } from '../src/utils';

/**
 * A promise plus the handle to settle it, so a spec can hold workers in flight
 * and assert how many the pool started.
 */
interface Gate {
  /**
   * Awaited by the worker.
   */
  promise: Promise<void>;

  /**
   * Lets that worker finish.
   */
  open: () => void;
}

function gate(): Gate {
  let open = (): void => undefined;

  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { promise, open };
}

describe('ConcurrencyPool.run', () => {
  it('visits every item exactly once, in order', async () => {
    const seen: number[] = [];

    await ConcurrencyPool.run([1, 2, 3, 4, 5], 2, (item) => {
      seen.push(item);

      return Promise.resolve();
    });

    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it('passes each item its index', async () => {
    const seen: [string, number][] = [];

    await ConcurrencyPool.run(['a', 'b'], 1, (item, index) => {
      seen.push([item, index]);

      return Promise.resolve();
    });

    expect(seen).toEqual([['a', 0], ['b', 1]]);
  });

  it('keeps at most the given number of workers in flight', async () => {
    const gates = Array.from({ length: 6 }, () => gate());
    let live = 0;
    let peak = 0;

    const done = ConcurrencyPool.run(gates, 2, async (item) => {
      live += 1;
      peak = Math.max(peak, live);

      await item.promise;

      live -= 1;
    });

    await Promise.resolve();

    expect(live).toBe(2);

    gates.forEach((item) => item.open());
    await done;

    expect(peak).toBe(2);
  });

  it('starts the next item as soon as a slot frees up', async () => {
    const gates = Array.from({ length: 3 }, () => gate());
    const started: number[] = [];

    const done = ConcurrencyPool.run(gates, 1, async (item, index) => {
      started.push(index);

      await item.promise;
    });

    await Promise.resolve();

    expect(started).toEqual([0]);

    gates[0].open();
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual([0, 1]);

    gates.forEach((item) => item.open());
    await done;

    expect(started).toEqual([0, 1, 2]);
  });

  it('does not over-spawn for a cap above the queue length', async () => {
    let live = 0;
    let peak = 0;

    await ConcurrencyPool.run([1, 2], 10, (_item) => {
      live += 1;
      peak = Math.max(peak, live);
      live -= 1;

      return Promise.resolve();
    });

    expect(peak).toBe(1);
  });

  it('resolves on an empty queue without calling the worker', async () => {
    const worker = jest.fn().mockResolvedValue(undefined);

    await ConcurrencyPool.run([], 4, worker);

    expect(worker).not.toHaveBeenCalled();
  });

  it('treats a cap below one as one', async () => {
    const seen: number[] = [];

    await ConcurrencyPool.run([1, 2], 0, (item) => {
      seen.push(item);

      return Promise.resolve();
    });

    expect(seen).toEqual([1, 2]);
  });
});
