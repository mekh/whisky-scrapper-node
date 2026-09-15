import 'dotenv/config';
import 'reflect-metadata';

import {
  LOGIN_ATTEMPTS_PER_STAGE,
  LOGIN_ATTEMPT_MIN_INTERVAL_MS,
  LOGIN_PENALTY_SECONDS,
  LOGIN_THROTTLE_RETENTION_SEC,
} from '~constants';
import { AuthThrottleService } from '~domain/auth/services/auth-throttle.service';
import { TooManyRequestsError } from '~errors';
import { ValkeyService } from '~lib/valkey';
import type { LoginThrottleStanding, LoginThrottleState } from '~types';

/**
 * Own prefix per run, so a suite cannot collide with a locally running
 * application's ladders and its own keys can be swept whole.
 */
const PREFIX = `it:throttle:${Date.now()}:`;

const KEY_ROOT = 'auth:throttle:ladder';

let valkey: ValkeyService;
let service: AuthThrottleService;
let addresses = 0;

/**
 * An address nothing else in this suite throttles.
 *
 * @returns An address unique within the run.
 */
function freshAddress(): string {
  addresses += 1;

  return `198.51.100.${addresses}`;
}

/**
 * The key one address's ladder is stored under, without the client prefix.
 *
 * @param address - The caller's address.
 * @returns The key.
 */
function keyOf(address: string): string {
  return `${KEY_ROOT}:${address}`;
}

/**
 * Reads the clock the script reads, rather than this process's.
 *
 * The two are the same machine in production and are not here — the server
 * runs in a VM — so every stamp a test writes or asserts on has to come from
 * the same place the script's `TIME` does.
 *
 * @returns Epoch milliseconds according to Valkey.
 */
async function serverNow(): Promise<number> {
  const [seconds = '0', micros = '0'] = await valkey.getClient().time();

  return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
}

/**
 * Writes a caller's stored state, so a test can stand on a rung of the ladder
 * without waiting an hour to climb there.
 *
 * @param address - The caller's address.
 * @param state - The fields to set.
 * @returns Resolves once stored.
 */
async function seed(
  address: string,
  state: Partial<LoginThrottleState>,
): Promise<void> {
  const fields = Object.entries(state).flatMap(([field, value]) => [
    field,
    String(value),
  ]);

  await valkey.getClient().hset(keyOf(address), ...fields);
}

/**
 * Reads a caller's stored state back.
 *
 * @param address - The caller's address.
 * @returns The stored fields, zeroed where absent.
 */
async function read(address: string): Promise<LoginThrottleState> {
  const stored = await valkey.getClient().hgetall(keyOf(address));

  return {
    failures: Number(stored.failures ?? 0),
    stage: Number(stored.stage ?? 0),
    blockedUntil: Number(stored.blockedUntil ?? 0),
    lastAttemptAt: Number(stored.lastAttemptAt ?? 0),
  };
}

/**
 * Makes one attempt and reports how long it was refused for.
 *
 * @param address - The caller's address.
 * @returns The stated wait in milliseconds, or 0 when the attempt passed.
 */
async function refusedFor(address: string): Promise<number> {
  try {
    await service.assertAllowed(address);

    return 0;
  } catch (error) {
    const data = (error as TooManyRequestsError).data as {
      retryAfterMs: number;
    };

    return data.retryAfterMs;
  }
}

/**
 * Makes one attempt and reports the standing it answered with, whether it
 * was allowed or refused.
 *
 * @param address - The caller's address.
 * @returns The standing, or null when none was stated.
 */
async function standingOf(
  address: string,
): Promise<LoginThrottleStanding | null> {
  try {
    return await service.assertAllowed(address);
  } catch (error) {
    const data = (error as TooManyRequestsError).data as {
      standing?: LoginThrottleStanding;
    };

    return data.standing ?? null;
  }
}

/**
 * Records a run of failed attempts.
 *
 * @param address - The caller's address.
 * @param times - How many failures to record.
 * @returns Resolves once they are recorded.
 */
async function failTimes(address: string, times: number): Promise<void> {
  for (let attempt = 0; attempt < times; attempt += 1) {
    await service.registerFailure(address);
  }
}

/**
 * Waits out the one-per-second floor.
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

  service = new AuthThrottleService(valkey);

  await valkey.ping();
});

afterAll(async () => {
  const client = valkey.getClient();
  const stored = await client.keys(`${PREFIX}*`);

  if (stored.length > 0) {
    await client.del(...stored.map((key) => key.slice(PREFIX.length)));
  }

  valkey.disconnect();
});

describe('the login ladder over a live Valkey — counting failures', () => {
  /**
   * The race the move exists to close: `GET` then `SET` let two failures
   * landing together read the same count and write the same number back, so
   * one guess was free. It was there on a single process and would be routine
   * with several.
   */
  it('loses no failure when a burst of them arrives at once', async () => {
    const address = freshAddress();
    const failures = LOGIN_ATTEMPTS_PER_STAGE * 4;

    await Promise.all(
      Array.from({ length: failures }).map(async () =>
        service.registerFailure(address)
      ),
    );

    const state = await read(address);

    expect(state.stage).toBe(4);
    expect(state.failures).toBe(0);
  });

  it('allows a whole run before refusing anything', async () => {
    const address = freshAddress();

    await failTimes(address, LOGIN_ATTEMPTS_PER_STAGE - 1);

    const state = await read(address);

    expect(state.failures).toBe(LOGIN_ATTEMPTS_PER_STAGE - 1);
    expect(state.blockedUntil).toBe(0);
  });

  it('imposes the first penalty as the run is exhausted', async () => {
    const address = freshAddress();
    const before = await serverNow();

    await failTimes(address, LOGIN_ATTEMPTS_PER_STAGE);

    const state = await read(address);
    const first = LOGIN_PENALTY_SECONDS[0]! * 1000;

    /**
     * Measured from before the call, so the penalty can only read long by
     * however much of a millisecond the call itself took.
     */
    const penalty = state.blockedUntil - before;

    expect(penalty).toBeGreaterThanOrEqual(first);
    expect(penalty).toBeLessThan(first + 1000);
    expect(state.failures).toBe(0);
  });
});

describe('the login ladder over a live Valkey — the rungs', () => {
  /**
   * Seeded onto each rung rather than climbed in real time: the last rung is
   * an hour, and what is under test is the ladder's arithmetic, not the
   * clock's.
   */
  it('charges the rung its stage names, and repeats the last', async () => {
    const rungs = [...LOGIN_PENALTY_SECONDS, LOGIN_PENALTY_SECONDS.at(-1)];

    const measured = await rungs.reduce<Promise<number[]>>(
      async (sofar, _penalty, stage) => {
        const seen = await sofar;
        const address = freshAddress();

        await seed(address, {
          stage,
          failures: LOGIN_ATTEMPTS_PER_STAGE - 1,
        });

        const before = await serverNow();

        await service.registerFailure(address);

        const state = await read(address);

        return [...seen, Math.round((state.blockedUntil - before) / 1000)];
      },
      Promise.resolve([]),
    );

    expect(measured).toEqual(rungs);
  });
});

describe('the login ladder over a live Valkey — a live penalty', () => {
  it('refuses for what is left of it', async () => {
    const address = freshAddress();
    const now = await serverNow();

    await seed(address, { blockedUntil: now + 5000 });

    const wait = await refusedFor(address);

    expect(wait).toBeGreaterThan(4000);
    expect(wait).toBeLessThanOrEqual(5000);
  });

  it('allows again once it has passed', async () => {
    const address = freshAddress();
    const now = await serverNow();

    await seed(address, { blockedUntil: now - 1 });

    await expect(refusedFor(address)).resolves.toBe(0);
  });

  /**
   * A refused attempt must write nothing, or a client that retries early
   * pushes its own recovery away and can never get back in.
   */
  it('writes nothing while refusing', async () => {
    const address = freshAddress();
    const now = await serverNow();

    await seed(address, { blockedUntil: now + 5000, lastAttemptAt: 1 });

    await refusedFor(address);
    await refusedFor(address);

    await expect(read(address)).resolves.toMatchObject({
      blockedUntil: now + 5000,
      lastAttemptAt: 1,
    });
  });
});

const FLOOR = 'the login ladder over a live Valkey — the one-per-second floor';

describe(FLOOR, () => {
  it('refuses a second attempt inside the same second', async () => {
    const address = freshAddress();

    await service.assertAllowed(address);

    const wait = await refusedFor(address);

    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(LOGIN_ATTEMPT_MIN_INTERVAL_MS);
  });

  it('allows one a second apart', async () => {
    const address = freshAddress();

    await service.assertAllowed(address);
    await sleep(LOGIN_ATTEMPT_MIN_INTERVAL_MS + 50);

    await expect(refusedFor(address)).resolves.toBe(0);
  });

  /**
   * The other half of the race: two attempts arriving together both used to
   * read "the last attempt was long ago" and both pass, which is exactly the
   * burst this floor exists to stop.
   */
  it('lets one of two simultaneous attempts through, not both', async () => {
    const address = freshAddress();

    const answers = await Promise.all(
      Array.from({ length: 10 }).map(async () => refusedFor(address)),
    );

    expect(answers.filter((wait) => wait === 0)).toHaveLength(1);
  });
});

describe('the login ladder over a live Valkey — its footprint', () => {
  it('clears the ladder outright on a successful login', async () => {
    const address = freshAddress();

    await failTimes(address, LOGIN_ATTEMPTS_PER_STAGE);
    await service.reset(address);

    const exists = await valkey.getClient().exists(keyOf(address));

    expect(exists).toBe(0);
    await expect(refusedFor(address)).resolves.toBe(0);
  });

  it('keeps two callers apart', async () => {
    const blocked = freshAddress();
    const other = freshAddress();

    await failTimes(blocked, LOGIN_ATTEMPTS_PER_STAGE);

    expect(await refusedFor(blocked)).toBeGreaterThan(0);
    await expect(refusedFor(other)).resolves.toBe(0);
  });

  /**
   * The retention has to outlast the longest penalty, or the stage would be
   * forgotten during the very wait it imposed.
   */
  it('keeps the state for the retention window', async () => {
    const address = freshAddress();

    await service.registerFailure(address);

    const ttl = await valkey.getClient().ttl(keyOf(address));

    expect(ttl).toBeGreaterThan(LOGIN_THROTTLE_RETENTION_SEC - 10);
    expect(ttl).toBeLessThanOrEqual(LOGIN_THROTTLE_RETENTION_SEC);
  });
});

describe('the login ladder over a live Valkey — failure', () => {
  /**
   * Fail-open: this throttle protects a password from being guessed, and a
   * cache that cannot answer must not become one that refuses every login.
   */
  it('allows the attempt when the connection is gone', async () => {
    const dead = new ValkeyService({
      host: process.env.VALKEY_HOST ?? '127.0.0.1',
      port: Number(process.env.VALKEY_PORT ?? 6379),
      keyPrefix: PREFIX,
      enableOfflineQueue: false,
      lazyConnect: true,
    });

    const offline = new AuthThrottleService(dead);

    dead.disconnect();

    const address = freshAddress();

    await expect(offline.assertAllowed(address)).resolves.toBeNull();
    await expect(offline.registerFailure(address)).resolves.toBeNull();
    await expect(offline.reset(address)).resolves.toBeUndefined();
  });
});

/**
 * The standing both scripts report, which is what `../web` draws under the
 * login form. It is asserted against a live Valkey because the arithmetic
 * behind it — the failure count, and the penalty a failure imposes — is in
 * the Lua and nowhere else.
 */
const STANDING = 'the login ladder over a live Valkey — the standing';

describe(STANDING, () => {
  it('counts a run down as the failures land', async () => {
    const address = freshAddress();

    const counted = await Array.from({ length: LOGIN_ATTEMPTS_PER_STAGE - 1 })
      .reduce<Promise<number[]>>(async (sofar) => {
        const seen = await sofar;
        const standing = await service.registerFailure(address);

        return [...seen, standing?.remaining ?? -1];
      }, Promise.resolve([]));

    expect(counted).toEqual([4, 3, 2, 1]);
  });

  /**
   * The failure that exhausts the run answers with the penalty it imposed,
   * which is the one response that has to say both "none left" and "wait
   * this long".
   */
  it('reports the penalty on the failure that imposes it', async () => {
    const address = freshAddress();

    await failTimes(address, LOGIN_ATTEMPTS_PER_STAGE - 1);

    const standing = await service.registerFailure(address);

    expect(standing?.blockedForMs).toBe(LOGIN_PENALTY_SECONDS[0]! * 1000);
  });

  it('reports what is left of a live penalty on a refusal', async () => {
    const address = freshAddress();
    const now = await serverNow();

    await seed(address, { blockedUntil: now + 5000 });

    const standing = await standingOf(address);

    expect(standing?.blockedForMs).toBeGreaterThan(4000);
    expect(standing?.blockedForMs).toBeLessThanOrEqual(5000);
  });

  /**
   * A second of spacing is not a block. The attempt is still refused and
   * still states its wait — it is `blockedForMs` that must stay zero, or the
   * form would count down a penalty nobody imposed.
   */
  it('reports no penalty when it is the spacing that refused', async () => {
    const address = freshAddress();

    await service.assertAllowed(address);

    const standing = await standingOf(address);

    expect(await refusedFor(address)).toBeGreaterThan(0);
    expect(standing?.blockedForMs).toBe(0);
  });

  it('reports a full run to a caller with no history', async () => {
    const standing = await standingOf(freshAddress());

    expect(standing).toEqual({
      limit: LOGIN_ATTEMPTS_PER_STAGE,
      remaining: LOGIN_ATTEMPTS_PER_STAGE,
      blockedForMs: 0,
    });
  });
});
