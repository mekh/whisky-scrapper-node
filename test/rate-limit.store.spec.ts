import 'reflect-metadata';

import { RateLimitStore } from '~app/rate-limit';
import type { RateLimitConfig } from '~config';
import type { RateLimitRule } from '~types';

const RULE: RateLimitRule = { ratePerSec: 3, burst: 10 };

const ONE_PER_SEC: RateLimitRule = { ratePerSec: 1, burst: 1 };

/**
 * Builds a store over a stubbed config, so a test states the two numbers it
 * cares about instead of reading the environment.
 *
 * @param overrides - Config fields to set.
 * @returns The store under test.
 */
function makeStore(
  overrides: Partial<Pick<RateLimitConfig, 'maxKeys' | 'sweepIntervalMs'>> = {},
): RateLimitStore {
  const config = {
    maxKeys: 1000,
    sweepIntervalMs: 60000,
    ...overrides,
  } as RateLimitConfig;

  return new RateLimitStore(config);
}

/**
 * Charges one key repeatedly and reports how many attempts were allowed.
 *
 * @param store - The store to charge.
 * @param key - The bucket to charge.
 * @param times - How many attempts to make.
 * @param rule - The rule to charge against.
 * @returns The number of allowed attempts.
 */
function chargeMany(
  store: RateLimitStore,
  key: string,
  times: number,
  rule: RateLimitRule = RULE,
): number {
  return Array.from({ length: times })
    .filter(() => store.consume(key, rule).allowed)
    .length;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-08T12:00:00.000Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('RateLimitStore — the burst', () => {
  it('lets a full burst through at once', () => {
    const store = makeStore();

    expect(chargeMany(store, 'user:a', RULE.burst)).toBe(RULE.burst);
  });

  it('refuses the request after the burst is spent', () => {
    const store = makeStore();

    chargeMany(store, 'user:a', RULE.burst);

    const decision = store.consume('user:a', RULE);

    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
  });

  it('states the limit and the headroom on an allowed request', () => {
    const store = makeStore();
    const decision = store.consume('user:a', RULE);

    expect(decision.limit).toBe(RULE.burst);
    expect(decision.remaining).toBe(RULE.burst - 1);
    expect(decision.retryAfterMs).toBe(0);
  });
});

describe('RateLimitStore — the refill', () => {
  it('hands back one token per rate interval', () => {
    const store = makeStore();

    chargeMany(store, 'user:a', RULE.burst);

    jest.advanceTimersByTime(Math.ceil(1000 / RULE.ratePerSec));

    expect(store.consume('user:a', RULE).allowed).toBe(true);
  });

  it('holds the sustained rate over a second', () => {
    const store = makeStore();

    chargeMany(store, 'user:a', RULE.burst);

    jest.advanceTimersByTime(1000);

    expect(chargeMany(store, 'user:a', 10)).toBe(RULE.ratePerSec);
  });

  it('never refills past the burst', () => {
    const store = makeStore();

    chargeMany(store, 'user:a', RULE.burst);

    jest.advanceTimersByTime(3600_000);

    expect(chargeMany(store, 'user:a', 50)).toBe(RULE.burst);
  });

  it('says when the next token lands', () => {
    const store = makeStore();

    store.consume('user:a', ONE_PER_SEC);

    const refused = store.consume('user:a', ONE_PER_SEC);

    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBe(1000);
  });

  /**
   * A refused request must not push the caller's own recovery further away,
   * or a client that retries early can never recover at all.
   */
  it('charges no token for a refused request', () => {
    const store = makeStore();

    store.consume('user:a', ONE_PER_SEC);
    store.consume('user:a', ONE_PER_SEC);
    store.consume('user:a', ONE_PER_SEC);

    jest.advanceTimersByTime(1000);

    expect(store.consume('user:a', ONE_PER_SEC).allowed).toBe(true);
  });
});

describe('RateLimitStore — bucket isolation', () => {
  it('keeps callers apart', () => {
    const store = makeStore();

    chargeMany(store, 'user:a', RULE.burst);

    expect(store.consume('user:b', RULE).allowed).toBe(true);
  });

  it('keeps scopes of one caller apart', () => {
    const store = makeStore();

    chargeMany(store, 'global|user:a', RULE.burst);

    expect(store.consume('strict|Coll|user:a', RULE).allowed).toBe(true);
  });
});

describe('RateLimitStore — bounded memory', () => {
  it('drops the least recently charged bucket past the cap', () => {
    const store = makeStore({ maxKeys: 2 });

    store.consume('user:a', RULE);
    store.consume('user:b', RULE);
    store.consume('user:c', RULE);

    expect(store.size).toBe(2);
  });

  /**
   * A bucket that has refilled to capacity answers exactly as a missing one
   * does, so keeping it is pure memory. The sweep is what stops the map from
   * growing for the lifetime of the process.
   */
  it('sweeps buckets that have refilled to capacity', () => {
    const store = makeStore({ sweepIntervalMs: 1000 });

    store.consume('user:a', RULE);

    expect(store.size).toBe(1);

    jest.advanceTimersByTime(60_000);
    store.consume('user:b', RULE);

    expect(store.size).toBe(1);
  });

  it('keeps a bucket that is still recovering', () => {
    const store = makeStore({ sweepIntervalMs: 1000 });

    chargeMany(store, 'user:a', RULE.burst);

    jest.advanceTimersByTime(1500);
    store.consume('user:b', RULE);

    expect(store.size).toBe(2);
  });
});
