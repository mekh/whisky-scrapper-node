import 'dotenv/config';
import 'reflect-metadata';

import { CRON_LOCK_TTL_SEC } from '~constants';
import { CronLockService } from '~lib/cron-lock';
import type { InstanceService } from '~lib/instance';
import { ValkeyService } from '~lib/valkey';

/**
 * Own prefix per run, so a suite cannot collide with a locally running
 * application's claims and its own keys can be swept whole.
 */
const PREFIX = `it:cron:${Date.now()}:`;

let valkey: ValkeyService;
let jobs = 0;

/**
 * A job name nothing else in this suite claims.
 *
 * @returns A name unique within the run.
 */
function freshJob(): string {
  jobs += 1;

  return `job-${jobs}`;
}

/**
 * Builds a lock service standing in for one instance.
 *
 * @param id - The instance id it claims as.
 * @returns The service.
 */
function asInstance(id: string): CronLockService {
  return new CronLockService(valkey, { id } as InstanceService);
}

beforeAll(async () => {
  valkey = new ValkeyService({
    host: process.env.VALKEY_HOST ?? '127.0.0.1',
    port: Number(process.env.VALKEY_PORT ?? 6379),
    keyPrefix: PREFIX,
  });

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

describe('the cron tick claim over a live Valkey', () => {
  /**
   * What step 5 is for: every instance arms the same schedule and fires at
   * the same moment, and exactly one of them may run the job.
   */
  it('lets exactly one of many instances take the same tick', async () => {
    const job = freshJob();

    const instances = Array.from(
      { length: 8 },
      (_unused, index) => asInstance(`host:${index}:aaaaaa`),
    );

    const answers = await Promise.all(
      instances.map(async (locks) => locks.claim(job)),
    );

    expect(answers.filter(Boolean)).toHaveLength(1);
  });

  it('records the winner, so the log can name it', async () => {
    const job = freshJob();

    await asInstance('host:9:winner').claim(job);

    await expect(valkey.get(`cron:${job}`)).resolves.toBe('host:9:winner');
  });

  it('expires the claim, so the next tick is a fresh race', async () => {
    const job = freshJob();

    await asInstance('host:9:winner').claim(job);

    const ttl = await valkey.getClient().ttl(`cron:${job}`);

    expect(ttl).toBeGreaterThan(CRON_LOCK_TTL_SEC - 10);
    expect(ttl).toBeLessThanOrEqual(CRON_LOCK_TTL_SEC);
  });

  it('keeps two jobs apart', async () => {
    const one = freshJob();
    const two = freshJob();
    const locks = asInstance('host:9:winner');

    await locks.claim(one);

    await expect(locks.claim(two)).resolves.toBe(true);
  });

  /**
   * Fail-open: the claim keeps the fleet tidy, it is not what makes either
   * job safe to run twice, so a cache outage must not stop the schedule.
   */
  it('runs the tick anyway when the connection is gone', async () => {
    const dead = new ValkeyService({
      host: process.env.VALKEY_HOST ?? '127.0.0.1',
      port: Number(process.env.VALKEY_PORT ?? 6379),
      keyPrefix: PREFIX,
      enableOfflineQueue: false,
      lazyConnect: true,
    });

    const locks = new CronLockService(
      dead,
      { id: 'host:9:offline' } as InstanceService,
    );

    dead.disconnect();

    await expect(locks.claim(freshJob())).resolves.toBe(true);
  });
});
