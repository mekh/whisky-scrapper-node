import 'reflect-metadata';

import {
  INSTANCE_HEARTBEAT_INTERVAL_MS,
  INSTANCE_HEARTBEAT_TTL_SEC,
} from '~constants';
import { InstanceService } from '~lib/instance';
import type { ValkeyService } from '~lib/valkey';

/**
 * The three commands the heartbeat uses, recording what it was asked and
 * answering what a test told it to.
 */
class FakeClient {
  public readonly written: [string, string, string, number][] = [];

  public readonly deleted: string[] = [];

  public alive = new Set<string>();

  public failing = false;

  /**
   * Records a liveness key.
   *
   * @param key - The key written.
   * @param value - Its value.
   * @param mode - The expiry mode, `EX`.
   * @param ttl - The expiry in seconds.
   * @returns The driver's acknowledgement.
   */
  public async set(
    key: string,
    value: string,
    mode: string,
    ttl: number,
  ): Promise<string> {
    this.assertUp();
    this.written.push([key, value, mode, ttl]);
    this.alive.add(key);

    return 'OK';
  }

  /**
   * Reads several liveness keys at once.
   *
   * @param keys - The keys to read.
   * @returns One value per key, null where it is gone.
   */
  public async mget(...keys: string[]): Promise<(string | null)[]> {
    this.assertUp();

    return keys.map((key) => this.alive.has(key) ? 'stamp' : null);
  }

  /**
   * Drops a liveness key.
   *
   * @param key - The key to drop.
   * @returns How many keys were removed.
   */
  public async del(key: string): Promise<number> {
    this.assertUp();
    this.deleted.push(key);

    return this.alive.delete(key) ? 1 : 0;
  }

  /**
   * Fails every command once the client is marked down.
   *
   * @throws {Error} When the client is set to fail.
   */
  private assertUp(): void {
    if (this.failing) {
      throw new Error('valkey is down');
    }
  }
}

/**
 * Builds the service over a fake client.
 *
 * @returns The service and the client behind it.
 */
function makeInstance(): { service: InstanceService; client: FakeClient } {
  const client = new FakeClient();

  const valkey = {
    getClient: () => client,
  } as unknown as ValkeyService;

  return { service: new InstanceService(valkey), client };
}

describe('InstanceService — who this process is', () => {
  it('names itself by host, process and a random suffix', () => {
    const { service } = makeInstance();

    expect(service.id).toMatch(/^[^:]+:\d+:[0-9a-f]{6}$/);
  });

  /**
   * The random suffix is what makes the name unique in time: without it a
   * restart that reused a process id could read its own predecessor's
   * leftover key and conclude a dead run is alive.
   */
  it('never repeats a name', () => {
    const one = makeInstance().service;
    const two = makeInstance().service;

    expect(one.id).not.toBe(two.id);
  });

  it('fits the column that records it', () => {
    const { service } = makeInstance();

    expect(service.id.length).toBeLessThanOrEqual(64);
  });
});

describe('InstanceService — the heartbeat', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('announces itself with an expiry', async () => {
    const { service, client } = makeInstance();

    await service.onApplicationBootstrap();

    expect(client.written).toHaveLength(1);
    expect(client.written[0]?.[0]).toBe(`instance:${service.id}`);
    expect(client.written[0]?.[2]).toBe('EX');
    expect(client.written[0]?.[3]).toBe(INSTANCE_HEARTBEAT_TTL_SEC);

    await service.onModuleDestroy();
  });

  it('keeps refreshing it', async () => {
    const { service, client } = makeInstance();

    await service.onApplicationBootstrap();

    jest.advanceTimersByTime(INSTANCE_HEARTBEAT_INTERVAL_MS * 3);

    expect(client.written.length).toBeGreaterThan(1);

    await service.onModuleDestroy();
  });

  /**
   * A clean shutdown drops the key, so the next boot sweeps that instance's
   * run at once instead of waiting out the expiry.
   */
  it('drops its key on shutdown and stops beating', async () => {
    const { service, client } = makeInstance();

    await service.onApplicationBootstrap();
    await service.onModuleDestroy();

    const written = client.written.length;

    jest.advanceTimersByTime(INSTANCE_HEARTBEAT_INTERVAL_MS * 3);

    expect(client.deleted).toEqual([`instance:${service.id}`]);
    expect(client.written).toHaveLength(written);
  });

  it('survives a cache that cannot answer', async () => {
    const { service, client } = makeInstance();

    client.failing = true;

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
  });
});

describe('InstanceService — who else is up', () => {
  it('answers the ids that are still there', async () => {
    const { service, client } = makeInstance();
    const other = makeInstance().service;

    await service.onApplicationBootstrap();

    await expect(service.aliveAmong([service.id, other.id])).resolves
      .toEqual(new Set([service.id]));

    client.failing = false;
    await service.onModuleDestroy();
  });

  it('asks nothing when there is nobody to ask about', async () => {
    const { service, client } = makeInstance();

    await expect(service.aliveAmong([])).resolves.toEqual(new Set());
    expect(client.written).toHaveLength(0);
  });

  /**
   * The distinction the sweep depends on: "nobody answered" is not "nobody
   * is alive", and reading it as the latter would close a live sibling's run
   * and release the lock it holds.
   */
  it('answers null rather than an empty set when it cannot tell', async () => {
    const { service, client } = makeInstance();

    client.failing = true;

    await expect(service.aliveAmong(['host:1:abcdef'])).resolves.toBeNull();
  });
});
