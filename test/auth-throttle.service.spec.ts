import 'reflect-metadata';

import { LOGIN_ATTEMPTS_PER_STAGE, LOGIN_PENALTY_SECONDS } from '~constants';
import { AuthThrottleService } from '~domain/auth/services/auth-throttle.service';
import { TooManyRequestsError } from '~errors';
import type { ValkeyService } from '~lib/valkey';

const ADDRESS = '203.0.113.7';

const SECOND_MS = 1000;

/**
 * The smallest cache the service actually uses: a string get/set/del. Kept as
 * a plain map rather than a mock so the ladder is exercised against real
 * round-tripped JSON.
 */
class FakeCache {
  public failing = false;

  private readonly entries = new Map<string, string>();

  /**
   * Reads a key.
   *
   * @param key - The key to read.
   * @returns The stored value, or null.
   * @throws {Error} When the cache is set to fail.
   */
  public get(key: string): Promise<string | null> {
    this.assertUp();

    return Promise.resolve(this.entries.get(key) ?? null);
  }

  /**
   * Writes a key, ignoring the expiry arguments the service passes.
   *
   * @param key - The key to write.
   * @param value - The value to store.
   * @returns Resolves once stored.
   * @throws {Error} When the cache is set to fail.
   */
  public set(key: string, value: string): Promise<string> {
    this.assertUp();
    this.entries.set(key, value);

    return Promise.resolve('OK');
  }

  /**
   * Deletes a key.
   *
   * @param key - The key to delete.
   * @returns How many keys were removed.
   * @throws {Error} When the cache is set to fail.
   */
  public del(key: string): Promise<number> {
    this.assertUp();

    return Promise.resolve(this.entries.delete(key) ? 1 : 0);
  }

  /**
   * Fails every command once the cache is marked down.
   *
   * @throws {Error} When the cache is set to fail.
   */
  private assertUp(): void {
    if (this.failing) {
      throw new Error('valkey is down');
    }
  }
}

/**
 * Builds the service over a fake cache.
 *
 * @returns The service and the cache behind it.
 */
function makeService(): { service: AuthThrottleService; cache: FakeCache } {
  const cache = new FakeCache();

  const valkey = {
    getClient: () => cache,
  } as unknown as ValkeyService;

  return { service: new AuthThrottleService(valkey), cache };
}

/**
 * Makes one failing attempt: asserts it is allowed through, then records the
 * failure, exactly as `AuthService.login` does.
 *
 * @param service - The throttle under test.
 * @returns Resolves once the failure is recorded.
 */
async function failOnce(service: AuthThrottleService): Promise<void> {
  await service.assertAllowed(ADDRESS);
  await service.registerFailure(ADDRESS);
}

/**
 * Burns one whole run of attempts, spacing them a second apart so the
 * one-per-second rule never interferes.
 *
 * @param service - The throttle under test.
 * @returns Resolves once the run is exhausted and the penalty imposed.
 */
async function burnRun(service: AuthThrottleService): Promise<void> {
  for (let attempt = 0; attempt < LOGIN_ATTEMPTS_PER_STAGE; attempt += 1) {
    if (attempt > 0) {
      jest.advanceTimersByTime(SECOND_MS);
    }

    await failOnce(service);
  }
}

/**
 * Reads back how long the throttle now refuses for.
 *
 * @param service - The throttle under test.
 * @returns The stated wait in seconds, or 0 when the attempt is allowed.
 */
async function refusedFor(service: AuthThrottleService): Promise<number> {
  try {
    await service.assertAllowed(ADDRESS);

    return 0;
  } catch (error) {
    const data = (error as TooManyRequestsError).data as {
      retryAfterMs: number;
    };

    return Math.round(data.retryAfterMs / SECOND_MS);
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-08T12:00:00.000Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('AuthThrottleService — a run of attempts', () => {
  it('allows a full run before refusing anything', async () => {
    const { service } = makeService();

    await burnRun(service);

    expect(await refusedFor(service)).toBe(LOGIN_PENALTY_SECONDS[0]);
  });

  it('refuses for the penalty remainder, then allows again', async () => {
    const { service } = makeService();

    await burnRun(service);

    jest.advanceTimersByTime(2 * SECOND_MS);

    expect(await refusedFor(service)).toBe(LOGIN_PENALTY_SECONDS[0] - 2);

    jest.advanceTimersByTime(LOGIN_PENALTY_SECONDS[0] * SECOND_MS);

    expect(await refusedFor(service)).toBe(0);
  });

  it('grants a fresh run after each penalty', async () => {
    const { service } = makeService();

    await burnRun(service);
    jest.advanceTimersByTime(LOGIN_PENALTY_SECONDS[0] * SECOND_MS);

    /**
     * The run itself must go through: were the stage counted per attempt
     * rather than per exhausted run, the first of these would already be
     * refused.
     */
    await expect(burnRun(service)).resolves.toBeUndefined();
  });
});

describe('AuthThrottleService — the ladder', () => {
  it('climbs through every rung and then stays on the last', async () => {
    const { service } = makeService();
    const seen: number[] = [];

    for (const penalty of [...LOGIN_PENALTY_SECONDS, 3600]) {
      await burnRun(service);
      seen.push(await refusedFor(service));

      jest.advanceTimersByTime(penalty * SECOND_MS);
    }

    expect(seen).toEqual([...LOGIN_PENALTY_SECONDS, 3600]);
  });
});

describe('AuthThrottleService — the one-per-second floor', () => {
  it('refuses a second attempt inside the same second', async () => {
    const { service } = makeService();

    await service.assertAllowed(ADDRESS);

    jest.advanceTimersByTime(300);

    expect(await refusedFor(service)).toBe(1);
  });

  it('allows one a second apart', async () => {
    const { service } = makeService();

    await service.assertAllowed(ADDRESS);

    jest.advanceTimersByTime(SECOND_MS);

    expect(await refusedFor(service)).toBe(0);
  });
});

describe('AuthThrottleService — a successful login', () => {
  /**
   * The reason the ladder counts failures rather than attempts: without this
   * reset, a person logging in across five devices would be made to wait
   * five seconds, then ten, then a minute.
   */
  it('clears the ladder outright', async () => {
    const { service } = makeService();

    await failOnce(service);
    jest.advanceTimersByTime(SECOND_MS);
    await failOnce(service);
    jest.advanceTimersByTime(SECOND_MS);

    await service.reset(ADDRESS);

    /**
     * A cleared caller starts from a full run again, and is not even held to
     * the spacing rule, having no recorded attempt.
     */
    await expect(burnRun(service)).resolves.toBeUndefined();
    expect(await refusedFor(service)).toBe(LOGIN_PENALTY_SECONDS[0]);
  });
});

describe('AuthThrottleService — the cache', () => {
  /**
   * Fail-open is deliberate: this throttle protects a password from being
   * guessed, and a cache that cannot answer must not become one that
   * refuses every login. The edge `limit_req` and the per-caller limiter
   * both still apply.
   */
  it('allows the attempt when the cache is unreachable', async () => {
    const { service, cache } = makeService();

    await burnRun(service);
    cache.failing = true;

    await expect(service.assertAllowed(ADDRESS)).resolves.toBeUndefined();
    await expect(service.registerFailure(ADDRESS)).resolves.toBeUndefined();
    await expect(service.reset(ADDRESS)).resolves.toBeUndefined();
  });

  it('discards an unreadable record instead of failing the login', async () => {
    const { service, cache } = makeService();

    await cache.set('auth:throttle:login:203.0.113.7', 'not json');

    await expect(service.assertAllowed(ADDRESS)).resolves.toBeUndefined();
  });

  it('keeps two callers apart', async () => {
    const { service } = makeService();

    await burnRun(service);

    await expect(service.assertAllowed('198.51.100.4')).resolves
      .toBeUndefined();
  });
});
