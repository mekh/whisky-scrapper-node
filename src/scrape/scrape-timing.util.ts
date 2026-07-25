/**
 * Sleeps for a number of milliseconds.
 *
 * @param ms - How long to sleep.
 * @returns Resolves once the delay has elapsed.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A uniform random number in `[from, to)`.
 *
 * @param from - Lower bound.
 * @param to - Upper bound.
 * @returns A random number in the range.
 */
export function randomBetween(from: number, to: number): number {
  return from + Math.random() * (to - from);
}

/**
 * Sleeps for a jittered delay drawn from a `[from, to]` range (seconds), scaled
 * by a multiplier — the per-request politeness pacing shared by every store.
 *
 * @param from - Lower delay bound, in seconds.
 * @param to - Upper delay bound, in seconds.
 * @param multiplier - Delay multiplier (1 = as configured).
 * @returns Resolves once the delay has elapsed.
 */
export function politeSleep(
  from: number,
  to: number,
  multiplier: number,
): Promise<void> {
  return sleep(randomBetween(from, to) * multiplier * 1000);
}
