import 'reflect-metadata';

import { CRON_LOCK_TTL_SEC } from '~constants';
import { CronLockService } from '~lib/cron-lock';
import type { InstanceService } from '~lib/instance';
import type { ValkeyService } from '~lib/valkey';

const INSTANCE = 'host:1:abcdef';

const JOB = 'store-full-sync';

/**
 * The two commands a claim uses: the conditional write, and the read that
 * names the holder when the write loses.
 */
class FakeClient {
  public readonly writes: [string, string, string, number, string][] = [];

  public failing = false;

  private readonly entries = new Map<string, string>();

  /**
   * Writes a key only when it is free, as `SET NX` does.
   *
   * @param key - The key to claim.
   * @param value - Who is claiming it.
   * @param mode - The expiry mode, `EX`.
   * @param ttl - The expiry in seconds.
   * @param nx - The `NX` flag.
   * @returns The driver's acknowledgement, or null when the key was taken.
   * @throws {Error} When the client is set to fail.
   */
  public async set(
    key: string,
    value: string,
    mode: string,
    ttl: number,
    nx: string,
  ): Promise<string | null> {
    this.assertUp();
    this.writes.push([key, value, mode, ttl, nx]);

    if (this.entries.has(key)) {
      return null;
    }

    this.entries.set(key, value);

    return 'OK';
  }

  /**
   * Reads a key.
   *
   * @param key - The key to read.
   * @returns Its value, or null.
   * @throws {Error} When the client is set to fail.
   */
  public async get(key: string): Promise<string | null> {
    this.assertUp();

    return this.entries.get(key) ?? null;
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
 * Builds a lock service over a fake client.
 *
 * @param client - The client to share, so two services can race on one.
 * @param id - The instance id this service claims as.
 * @returns The service and its client.
 */
function makeLock(
  client = new FakeClient(),
  id = INSTANCE,
): { locks: CronLockService; client: FakeClient } {
  const valkey = {
    getClient: () => client,
  } as unknown as ValkeyService;

  const instances = { id } as InstanceService;

  return { locks: new CronLockService(valkey, instances), client };
}

describe('CronLockService', () => {
  it('claims a free tick and records who took it', async () => {
    const { locks, client } = makeLock();

    await expect(locks.claim(JOB)).resolves.toBe(true);

    expect(client.writes[0]).toEqual([
      `cron:${JOB}`,
      INSTANCE,
      'EX',
      CRON_LOCK_TTL_SEC,
      'NX',
    ]);
  });

  /**
   * The whole point: every instance arms the same schedule and fires at the
   * same moment, and exactly one of them may run the job.
   */
  it('lets exactly one of two instances take the same tick', async () => {
    const shared = new FakeClient();
    const one = makeLock(shared, 'host:1:aaaaaa').locks;
    const two = makeLock(shared, 'host:2:bbbbbb').locks;

    const answers = await Promise.all([one.claim(JOB), two.claim(JOB)]);

    expect(answers.filter(Boolean)).toHaveLength(1);
  });

  it('keeps two jobs apart', async () => {
    const shared = new FakeClient();
    const { locks } = makeLock(shared);

    await locks.claim(JOB);

    await expect(locks.claim('currency-rate-sync')).resolves.toBe(true);
  });

  /**
   * Fail-open, deliberately: the claim keeps the fleet tidy, it is not what
   * makes either job safe to run twice, so a cache outage must not be able
   * to stop the schedule altogether.
   */
  it('runs the tick anyway when it cannot claim at all', async () => {
    const { locks, client } = makeLock();

    client.failing = true;

    await expect(locks.claim(JOB)).resolves.toBe(true);
  });
});
