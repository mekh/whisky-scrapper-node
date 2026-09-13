import 'dotenv/config';
import 'reflect-metadata';

import { RateLimitStore } from '~app/rate-limit';
import type { RateLimitConfig } from '~config';
import { RATE_LIMIT_KEY_ROOT } from '~constants';
import { ValkeyService } from '~lib/valkey';
import type { RateLimitCharge, RateLimitRule } from '~types';

/**
 * Own prefix per run, so a suite cannot collide with a locally running
 * application's buckets and its own keys can be swept whole.
 */
const PREFIX = `it:ratelimit:${Date.now()}:`;

const GLOBAL: RateLimitRule = { ratePerSec: 3, burst: 10 };

/**
 * A fast bucket, so a refill can be waited out in a test rather than mocked:
 * one token every 100 ms. Not faster than that — a rule that refills inside
 * the time a handful of round trips take makes its own tests flaky.
 */
const FAST: RateLimitRule = { ratePerSec: 10, burst: 2 };

/**
 * Comfortably longer than {@link FAST}'s 100 ms refill, and short enough not
 * to be felt in a suite.
 */
const REFILL_MS = 150;

const ONE_PER_SEC: RateLimitRule = { ratePerSec: 1, burst: 1 };

const CONFIG = { timeoutMs: 1000 } as RateLimitConfig;

let valkey: ValkeyService;
let store: RateLimitStore;
let keys = 0;

/**
 * A bucket nothing else in this suite charges.
 *
 * @returns A key unique within the run.
 */
function freshKey(): string {
  keys += 1;

  return `case${keys}`;
}

/**
 * Charges one bucket.
 *
 * @param key - The bucket to charge.
 * @param rule - The policy to charge it against.
 * @returns The bucket's decision.
 */
async function charge(
  key: string,
  rule: RateLimitRule = GLOBAL,
): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
  const [decision] = await store.consume([{ key, rule }]);

  if (!decision) {
    throw new Error('The store answered nothing');
  }

  return decision;
}

/**
 * Charges one bucket repeatedly and counts what was let through.
 *
 * @param key - The bucket to charge.
 * @param times - How many attempts to make.
 * @param rule - The policy to charge them against.
 * @returns The number of allowed attempts.
 */
async function chargeMany(
  key: string,
  times: number,
  rule: RateLimitRule = GLOBAL,
): Promise<number> {
  const decisions = [];

  for (let attempt = 0; attempt < times; attempt += 1) {
    decisions.push(await charge(key, rule));
  }

  return decisions.filter((decision) => decision.allowed).length;
}

/**
 * Waits out a refill.
 *
 * @param ms - How long to wait.
 * @returns Resolves after the wait.
 */
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

beforeAll(async () => {
  valkey = new ValkeyService({
    host: process.env.VALKEY_HOST ?? '127.0.0.1',
    port: Number(process.env.VALKEY_PORT ?? 6379),
    keyPrefix: PREFIX,
  });

  store = new RateLimitStore(CONFIG, valkey);

  await valkey.ping();
});

afterAll(async () => {
  const client = valkey.getClient();
  const stored = await client.keys(`${PREFIX}*`);

  if (stored.length > 0) {
    /**
     * `keys` answers with the prefix already applied and `del` applies it
     * again, so the prefix is stripped before deleting.
     */
    await client.del(...stored.map((key) => key.slice(PREFIX.length)));
  }

  valkey.disconnect();
});

describe('the rate-limit store over a live Valkey — the burst', () => {
  it('lets a full burst through at once', async () => {
    const key = freshKey();

    await expect(chargeMany(key, GLOBAL.burst)).resolves.toBe(GLOBAL.burst);
  });

  it('refuses the request after the burst is spent', async () => {
    const key = freshKey();

    await chargeMany(key, GLOBAL.burst);

    const decision = await charge(key);

    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
    expect(decision.retryAfterMs).toBeGreaterThan(0);
  });

  it('states the limit and the headroom on an allowed request', async () => {
    const [decision] = await store.consume([
      { key: freshKey(), rule: GLOBAL },
    ]);

    expect(decision).toEqual({
      allowed: true,
      limit: GLOBAL.burst,
      remaining: GLOBAL.burst - 1,
      retryAfterMs: 0,
    });
  });
});

describe('the rate-limit store over a live Valkey — the refill', () => {
  it('hands back a token once the rate has elapsed', async () => {
    const key = freshKey();

    await chargeMany(key, FAST.burst, FAST);

    const refused = await charge(key, FAST);

    expect(refused.allowed).toBe(false);

    await sleep(REFILL_MS);

    await expect(charge(key, FAST)).resolves.toMatchObject({ allowed: true });
  });

  it('never refills past the burst', async () => {
    const key = freshKey();

    await chargeMany(key, FAST.burst, FAST);
    await sleep(REFILL_MS * 4);

    await expect(chargeMany(key, 10, FAST)).resolves.toBe(FAST.burst);
  });

  /**
   * A refused request must not push the caller's own recovery further away,
   * or a client that retries early can never recover at all.
   */
  it('charges no token for a refused request', async () => {
    const key = freshKey();

    await chargeMany(key, 4, FAST);
    await sleep(REFILL_MS);

    await expect(charge(key, FAST)).resolves.toMatchObject({ allowed: true });
  });

  it('says when the next token lands', async () => {
    const key = freshKey();

    await charge(key, ONE_PER_SEC);

    const refused = await charge(key, ONE_PER_SEC);

    expect(refused.retryAfterMs).toBeGreaterThan(900);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(1000);
  });
});

describe('the rate-limit store over a live Valkey — the shared state', () => {
  /**
   * The reason the buckets moved out of the process at all: read-then-write
   * loses a charge whenever two land together, and with several instances
   * that is every busy moment.
   */
  it('loses no charge when a burst arrives at once', async () => {
    const key = freshKey();

    const decisions = await Promise.all(
      Array.from({ length: 60 }).map(async () => charge(key)),
    );

    expect(decisions.filter((decision) => decision.allowed))
      .toHaveLength(GLOBAL.burst);
  });

  it('keeps two callers apart', async () => {
    const mine = freshKey();
    const theirs = freshKey();

    await chargeMany(mine, GLOBAL.burst);

    await expect(charge(theirs)).resolves.toMatchObject({ allowed: true });
  });

  /**
   * A second store is another instance of the API as far as Valkey is
   * concerned, which is the whole point of the move.
   */
  it('shares one budget between two stores', async () => {
    const key = freshKey();
    const other = new RateLimitStore(CONFIG, valkey);

    await chargeMany(key, GLOBAL.burst);

    const [decision] = await other.consume([{ key, rule: GLOBAL }]);

    expect(decision?.allowed).toBe(false);
  });
});

describe('the rate-limit store over a live Valkey — a chain of buckets', () => {
  it('charges every bucket of an allowed request', async () => {
    const charges: RateLimitCharge[] = [
      { key: freshKey(), rule: GLOBAL },
      { key: freshKey(), rule: FAST },
    ];

    const decisions = await store.consume(charges);

    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.limit).toBe(GLOBAL.burst);
    expect(decisions[1]?.limit).toBe(FAST.burst);
  });

  /**
   * A request the global rule turns away must not spend the route's own
   * allowance — the two buckets are separate budgets, not one in series.
   */
  it('stops at the first refusal and spends nothing after it', async () => {
    const global = freshKey();
    const profile = freshKey();

    await chargeMany(global, GLOBAL.burst);

    const decisions = await store.consume([
      { key: global, rule: GLOBAL },
      { key: profile, rule: FAST },
    ]);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.allowed).toBe(false);

    const untouched = await charge(profile, FAST);

    expect(untouched.remaining).toBe(FAST.burst - 1);
  });
});

describe('the rate-limit store over a live Valkey — its footprint', () => {
  /**
   * What replaced the in-process cap and sweep: a bucket lives exactly as
   * long as it is still recovering, so the key count is bounded by the
   * arrival rate over a few seconds rather than by a configured ceiling.
   */
  it('expires a bucket when it would next be full', async () => {
    const key = freshKey();

    await charge(key);

    const ttl = await valkey.getClient().pttl(`${RATE_LIMIT_KEY_ROOT}:${key}`);

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(Math.ceil(1000 / GLOBAL.ratePerSec));
  });

  it('leaves nothing behind for a bucket that never refuses', async () => {
    const key = freshKey();

    await charge(key, FAST);
    await sleep(REFILL_MS * 2);

    const exists = await valkey.getClient()
      .exists(`${RATE_LIMIT_KEY_ROOT}:${key}`);

    expect(exists).toBe(0);
  });
});

describe('the rate-limit store over a live Valkey — failure', () => {
  /**
   * Fail-open: a store that cannot answer must not become an API that
   * refuses every request. The guard reads an empty answer as "not charged"
   * and lets the request through.
   */
  it('answers nothing when the connection is gone', async () => {
    const dead = new ValkeyService({
      host: process.env.VALKEY_HOST ?? '127.0.0.1',
      port: Number(process.env.VALKEY_PORT ?? 6379),
      keyPrefix: PREFIX,
      enableOfflineQueue: false,
      lazyConnect: true,
    });

    const offline = new RateLimitStore(CONFIG, dead);

    dead.disconnect();

    await expect(offline.consume([{ key: freshKey(), rule: GLOBAL }]))
      .resolves.toEqual([]);
  });
});
