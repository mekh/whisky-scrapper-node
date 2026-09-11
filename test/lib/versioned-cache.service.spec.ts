import 'reflect-metadata';

import { Logger } from '@nestjs/common';

import { CacheConfig } from '~config';
import { CACHE_GENERATION_CATALOGUE } from '~constants';
import { VersionedCacheService } from '~lib/cache';
import { ValkeyService } from '~lib/valkey';

const GENERATION = CACHE_GENERATION_CATALOGUE;

const GENERATION_KEY = `cache:gen:${GENERATION}`;

const REF = { scope: 'report', suffix: 'abc' };

/**
 * A chainable `MULTI` builder over the fake store.
 */
interface FakeTransaction {
  set: (key: string, value: string, mode: string) => FakeTransaction;
  incr: (key: string) => FakeTransaction;
  exec: () => Promise<[Error | null, unknown][]>;
}

/**
 * An in-memory stand-in for the commands the cache issues.
 */
interface FakeClient {
  store: Map<string, Buffer>;
  get: jest.Mock;
  set: jest.Mock;
  getBuffer: jest.Mock;
  del: jest.Mock;
  multi: jest.Mock;
}

/**
 * Builds a client backed by a plain map.
 *
 * @returns The fake client.
 */
function makeClient(): FakeClient {
  const store = new Map<string, Buffer>();

  const client: FakeClient = {
    store,
    get: jest.fn((key: string) => {
      const value = store.get(key);

      return Promise.resolve(value ? value.toString('utf8') : null);
    }),
    set: jest.fn((key: string, value: Buffer | string, ...rest: unknown[]) => {
      if (rest[0] === 'NX' && store.has(key)) {
        return Promise.resolve(null);
      }

      store.set(
        key,
        typeof value === 'string' ? Buffer.from(value, 'utf8') : value,
      );

      return Promise.resolve('OK');
    }),
    getBuffer: jest.fn((key: string) =>
      Promise.resolve(store.get(key) ?? null)
    ),
    del: jest.fn((key: string) => {
      store.delete(key);

      return Promise.resolve(1);
    }),
    multi: jest.fn(),
  };

  client.multi.mockImplementation(() => {
    const queued: (() => unknown)[] = [];

    const transaction: FakeTransaction = {
      set: (key, value, mode) => {
        queued.push(() => client.set(key, value, mode));

        return transaction;
      },
      incr: (key) => {
        queued.push(() => {
          const current = Number(store.get(key)?.toString('utf8') ?? '0');
          const next = current + 1;

          store.set(key, Buffer.from(String(next), 'utf8'));

          return next;
        });

        return transaction;
      },
      exec: async () => {
        const replies: [Error | null, unknown][] = [];

        for (const run of queued) {
          replies.push([null, await run()]);
        }

        return replies;
      },
    };

    return transaction;
  });

  return client;
}

/**
 * Builds a cache over a fake client.
 *
 * @param options - Config overrides and a replacement client.
 * @returns The service under test and the client behind it.
 */
function makeCache(options: {
  config?: Partial<CacheConfig>;
  client?: FakeClient;
} = {}): { cache: VersionedCacheService; client: FakeClient } {
  const client = options.client ?? makeClient();

  const config = {
    enabled: true,
    bootBump: true,
    ttlSec: 86400,
    readTimeoutMs: 50,
    maxEntryBytes: 8 * 1024 * 1024,
    ...options.config,
  } as CacheConfig;

  const valkey = {
    getClient: () => client,
    disconnect: jest.fn(),
  } as unknown as ValkeyService;

  return { cache: new VersionedCacheService(config, valkey), client };
}

describe('VersionedCacheService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'verbose').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs the loader and touches nothing when disabled', async () => {
    const { cache, client } = makeCache({ config: { enabled: false } });
    const loader = jest.fn().mockResolvedValue('value');

    expect(await cache.getOrCompute(REF, GENERATION, loader)).toBe('value');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(client.get).not.toHaveBeenCalled();
    expect(cache.stats().bypasses).toBe(1);
  });

  it('computes once and serves the second read from the cache', async () => {
    const { cache } = makeCache();
    const loader = jest.fn().mockResolvedValue({ rows: [1, 2, 3] });

    const first = await cache.getOrCompute(REF, GENERATION, loader);
    const second = await cache.getOrCompute(REF, GENERATION, loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('serves an empty answer instead of recomputing it', async () => {
    /**
     * A report that matched nothing is a legitimate answer, and reading a
     * stored empty array as "no entry" would recompute it on every request.
     */
    const { cache } = makeCache();
    const loader = jest.fn().mockResolvedValue([]);

    await cache.getOrCompute(REF, GENERATION, loader);

    expect(await cache.getOrCompute(REF, GENERATION, loader)).toEqual([]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('seeds a missing generation above any surviving entry', async () => {
    /**
     * A flushed or hand-deleted counter must not restart at 1, or entries
     * left over from before it vanished would be addressed again.
     */
    const { cache, client } = makeCache();

    const generation = await cache.readGeneration(GENERATION);
    const seconds = Math.floor(Date.now() / 1000);

    expect(generation).toBeGreaterThan(seconds - 10);
    expect(client.store.has(GENERATION_KEY)).toBe(true);
  });

  it('makes every stored entry unreachable after a bump', async () => {
    const { cache } = makeCache();
    const loader = jest.fn()
      .mockResolvedValueOnce('before')
      .mockResolvedValueOnce('after');

    expect(await cache.getOrCompute(REF, GENERATION, loader)).toBe('before');

    await cache.bump(GENERATION, 'test');

    expect(await cache.getOrCompute(REF, GENERATION, loader)).toBe('after');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('reports a miss when a read fails', async () => {
    const { cache, client } = makeCache();

    client.getBuffer.mockRejectedValue(new Error('connection refused'));

    const loader = jest.fn().mockResolvedValue('value');

    expect(await cache.getOrCompute(REF, GENERATION, loader)).toBe('value');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.stats().errors).toBeGreaterThan(0);
  });

  it('gives up on a read that outlives its deadline', async () => {
    const { cache, client } = makeCache({ config: { readTimeoutMs: 20 } });

    client.getBuffer.mockImplementation(() => new Promise(() => undefined));

    const loader = jest.fn().mockResolvedValue('value');
    const started = Date.now();

    expect(await cache.getOrCompute(REF, GENERATION, loader)).toBe('value');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(cache.stats().errors).toBeGreaterThan(0);
  });

  it('refuses to store an entry past the size cap', async () => {
    const { cache, client } = makeCache({ config: { maxEntryBytes: 16 } });
    const loader = jest.fn().mockResolvedValue({ padding: 'x'.repeat(500) });

    await cache.getOrCompute(REF, GENERATION, loader);

    const entries = [...client.store.keys()]
      .filter((key) => key !== GENERATION_KEY);

    expect(entries).toHaveLength(0);
    expect(cache.stats().bypasses).toBe(1);
  });

  it('drops an entry it cannot decode', async () => {
    const { cache, client } = makeCache();
    const loader = jest.fn().mockResolvedValue('value');

    await cache.getOrCompute(REF, GENERATION, loader);

    const key = [...client.store.keys()]
      .find((candidate) => candidate !== GENERATION_KEY) as string;

    client.store.set(key, Buffer.from('not json at all', 'utf8'));

    expect(await cache.getOrCompute(REF, GENERATION, loader)).toBe('value');
    expect(client.del).toHaveBeenCalledWith(key);
    expect(client.store.has(key)).toBe(true);
  });

  it('bypasses the cache while a bump is outstanding', async () => {
    const { cache, client } = makeCache();

    client.multi.mockImplementation(() => {
      throw new Error('connection refused');
    });

    await cache.bump(GENERATION, 'persist:test');

    expect(cache.stats().dirty).toBe(true);

    const loader = jest.fn().mockResolvedValue('value');

    await cache.getOrCompute(REF, GENERATION, loader);
    await cache.getOrCompute(REF, GENERATION, loader);

    /**
     * The write the failed bump belongs to has already committed, so every
     * stored entry may now be stale with nothing to supersede it. Serving
     * those is worse than serving nothing.
     */
    expect(loader).toHaveBeenCalledTimes(2);
    expect(cache.stats().hits).toBe(0);
  });

  it('resumes caching once an outstanding bump succeeds', async () => {
    const client = makeClient();
    const { cache } = makeCache({ client });
    const failing = client.multi.getMockImplementation();

    client.multi.mockImplementation(() => {
      throw new Error('connection refused');
    });

    await cache.bump(GENERATION, 'persist:test');

    expect(cache.stats().dirty).toBe(true);

    client.multi.mockImplementation(
      failing as unknown as () => FakeTransaction,
    );

    const loader = jest.fn().mockResolvedValue('value');

    await cache.getOrCompute(REF, GENERATION, loader);
    await cache.getOrCompute(REF, GENERATION, loader);

    expect(cache.stats().dirty).toBe(false);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.stats().hits).toBe(1);
  });

  it('bumps the catalogue generation at boot', async () => {
    const { cache, client } = makeCache();

    await cache.onApplicationBootstrap();

    expect(client.store.has(GENERATION_KEY)).toBe(true);
    expect(cache.stats().lastBumpAt).not.toBeNull();
  });

  it('skips the boot bump in a process that serves no reads', async () => {
    /**
     * A script's own startup bump would discard entries it is about to
     * supersede at the end of its run, and would fire on a dry run too.
     */
    const { cache, client } = makeCache({ config: { bootBump: false } });

    await cache.onApplicationBootstrap();

    expect(client.store.size).toBe(0);
    expect(cache.stats().lastBumpAt).toBeNull();
  });

  it('does not bump at boot when disabled', async () => {
    const { cache, client } = makeCache({ config: { enabled: false } });

    await cache.onApplicationBootstrap();

    expect(client.store.size).toBe(0);
    expect(cache.stats().lastBumpAt).toBeNull();
  });
});
