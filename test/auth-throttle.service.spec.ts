import 'reflect-metadata';

import {
  LOGIN_ATTEMPTS_PER_STAGE,
  LOGIN_ATTEMPT_MIN_INTERVAL_MS,
  LOGIN_PENALTY_SECONDS,
  LOGIN_THROTTLE_RETENTION_SEC,
} from '~constants';
import { AuthThrottleService } from '~domain/auth/services/auth-throttle.service';
import { TooManyRequestsError } from '~errors';
import type { ValkeyService } from '~lib/valkey';

const ADDRESS = '203.0.113.7';

const KEY = `auth:throttle:ladder:${ADDRESS}`;

/**
 * One command the service sent, as the driver received it.
 */
interface Sent {
  /**
   * Which command it was: a script's registered name, or `del`.
   */
  command: string;

  /**
   * Its arguments — for a script, the key count, then the keys, then `ARGV`.
   */
  args: unknown[];
}

/**
 * The smallest client the service uses: one that can have scripts defined on
 * it, run them, and delete a key.
 *
 * The ladder's own arithmetic lives in Lua now and is exercised against a
 * live Valkey in `test/integration/auth-throttle.integration.spec.ts`. What
 * is left here is what stays in TypeScript: the key, the arguments the
 * scripts are handed, and what the service does with their answers.
 */
class FakeClient {
  public readonly sent: Sent[] = [];

  /**
   * What each script answers, by the name it is registered under. Two
   * fields rather than one, because the two scripts answer different
   * shapes: the attempt states a decision and a standing, the failure only
   * the standing it just wrote.
   */
  public readonly replies: Record<string, unknown> = {
    authThrottleAttempt: [1, 0, 0, 0],
    authThrottleFailure: [0, 0],
  };

  public failing = false;

  /**
   * Registers a script as a command, the way the driver does.
   *
   * @param name - The command name to attach.
   */
  public defineCommand(name: string): void {
    const self = this as unknown as Record<string, unknown>;

    self[name] = async (...args: unknown[]): Promise<unknown> => {
      this.sent.push({ command: name, args });

      return this.answer(this.replies[name]);
    };
  }

  /**
   * Deletes a key.
   *
   * @param key - The key to delete.
   * @returns How many keys were removed.
   */
  public async del(key: string): Promise<number> {
    this.sent.push({ command: 'del', args: [key] });
    await this.answer(1);

    return 1;
  }

  /**
   * Answers the scripted reply, or fails when the client is marked down.
   *
   * @param reply - What this command is set to answer.
   * @returns The reply.
   * @throws {Error} When the client is set to fail.
   */
  private async answer(reply: unknown): Promise<unknown> {
    if (this.failing) {
      throw new Error('valkey is down');
    }

    return reply;
  }
}

/**
 * Builds the service over a fake client.
 *
 * @returns The service and the client behind it.
 */
function makeService(): {
  service: AuthThrottleService;
  client: FakeClient;
} {
  const client = new FakeClient();

  const valkey = {
    getClient: () => client,
  } as unknown as ValkeyService;

  return { service: new AuthThrottleService(valkey), client };
}

/**
 * The arguments of the one command of a kind the service sent.
 *
 * @param client - The client to read.
 * @param command - The command name to look for.
 * @returns Its arguments.
 */
function argsOf(client: FakeClient, command: string): unknown[] {
  return client.sent.find((one) => one.command === command)?.args ?? [];
}

describe('AuthThrottleService — what it asks the scripts', () => {
  it(
    'hands the attempt script the key, the spacing and the retention',
    async () => {
      const { service, client } = makeService();

      await service.assertAllowed(ADDRESS);

      expect(argsOf(client, 'authThrottleAttempt')).toEqual([
        1,
        KEY,
        LOGIN_ATTEMPT_MIN_INTERVAL_MS,
        LOGIN_THROTTLE_RETENTION_SEC,
      ]);
    },
  );

  /**
   * The ladder itself travels as arguments rather than being written into
   * the Lua, so the rungs stay stated once, in `~constants`.
   */
  it(
    'hands the failure script the run length and the whole ladder',
    async () => {
      const { service, client } = makeService();

      await service.registerFailure(ADDRESS);

      expect(argsOf(client, 'authThrottleFailure')).toEqual([
        1,
        KEY,
        LOGIN_ATTEMPTS_PER_STAGE,
        LOGIN_THROTTLE_RETENTION_SEC,
        ...LOGIN_PENALTY_SECONDS,
      ]);
    },
  );

  it('deletes that same key on a successful login', async () => {
    const { service, client } = makeService();

    await service.reset(ADDRESS);

    expect(argsOf(client, 'del')).toEqual([KEY]);
  });

  it('keeps two callers apart', async () => {
    const { service, client } = makeService();

    await service.assertAllowed('198.51.100.4');

    expect(argsOf(client, 'authThrottleAttempt')[1])
      .toBe('auth:throttle:ladder:198.51.100.4');
  });
});

describe('AuthThrottleService — what it does with the answer', () => {
  it('lets an allowed attempt through', async () => {
    const { service, client } = makeService();

    client.replies.authThrottleAttempt = [1, 0, 0, 0];

    await expect(service.assertAllowed(ADDRESS)).resolves.toEqual({
      limit: LOGIN_ATTEMPTS_PER_STAGE,
      remaining: LOGIN_ATTEMPTS_PER_STAGE,
      blockedForMs: 0,
    });
  });

  it('refuses with the wait the script stated', async () => {
    const { service, client } = makeService();

    client.replies.authThrottleAttempt = [0, 4500, 0, 4500];

    await expect(service.assertAllowed(ADDRESS)).rejects
      .toThrow(TooManyRequestsError);
  });

  /**
   * The message rounds up to whole seconds, since that is what a person is
   * told to wait; the millisecond figure rides in the error's data for the
   * client to pace itself by.
   */
  it('states the wait in seconds and carries it in milliseconds', async () => {
    const { service, client } = makeService();

    client.replies.authThrottleAttempt = [0, 4500, 0, 4500];

    const thrown = await service.assertAllowed(ADDRESS)
      .then(() => null)
      .catch((error: unknown) => error as TooManyRequestsError);

    expect(thrown?.message).toContain('5 s');
    expect(thrown?.data).toMatchObject({ retryAfterMs: 4500 });
  });
});

/**
 * What the two answers say about the caller's position, which is what
 * `../web` draws under the login form. The run length is applied here and
 * not in the Lua, so the scripts hand over a raw failure count.
 */
describe('AuthThrottleService — the standing it reports', () => {
  it('turns the failure count into attempts left', async () => {
    const { service, client } = makeService();

    client.replies.authThrottleFailure = [2, 0];

    await expect(service.registerFailure(ADDRESS)).resolves.toEqual({
      limit: LOGIN_ATTEMPTS_PER_STAGE,
      remaining: LOGIN_ATTEMPTS_PER_STAGE - 2,
      blockedForMs: 0,
    });
  });

  /**
   * The failure that exhausts a run answers with the penalty it just
   * imposed, which is the moment the form has to stop counting and start
   * counting down.
   */
  it('reports the penalty the last failure of a run imposed', async () => {
    const { service, client } = makeService();

    client.replies.authThrottleFailure = [0, 5000];

    await expect(service.registerFailure(ADDRESS)).resolves.toEqual({
      limit: LOGIN_ATTEMPTS_PER_STAGE,
      remaining: LOGIN_ATTEMPTS_PER_STAGE,
      blockedForMs: 5000,
    });
  });

  it('carries the standing on its own refusal', async () => {
    const { service, client } = makeService();

    client.replies.authThrottleAttempt = [0, 3200, 0, 3200];

    const thrown = await service.assertAllowed(ADDRESS)
      .then(() => null)
      .catch((error: unknown) => error as TooManyRequestsError);

    expect(thrown?.data).toEqual({
      retryAfterMs: 3200,
      standing: {
        limit: LOGIN_ATTEMPTS_PER_STAGE,
        remaining: LOGIN_ATTEMPTS_PER_STAGE,
        blockedForMs: 3200,
      },
    });
  });

  /**
   * A second of spacing is not a block: the wait is stated, so the caller
   * backs off, but nothing is drawn as a penalty because none is in force.
   */
  it('states no penalty when it is the spacing that refused', async () => {
    const { service, client } = makeService();

    client.replies.authThrottleAttempt = [0, 700, 3, 0];

    const thrown = await service.assertAllowed(ADDRESS)
      .then(() => null)
      .catch((error: unknown) => error as TooManyRequestsError);

    expect(thrown?.data).toEqual({
      retryAfterMs: 700,
      standing: {
        limit: LOGIN_ATTEMPTS_PER_STAGE,
        remaining: LOGIN_ATTEMPTS_PER_STAGE - 3,
        blockedForMs: 0,
      },
    });
  });
});

describe('AuthThrottleService — when the cache cannot answer', () => {
  /**
   * Fail-open is deliberate: this throttle protects a password from being
   * guessed, and a cache that cannot answer must not become one that refuses
   * every login. The edge `limit_req` and the per-caller limiter both still
   * apply.
   */
  it('allows the attempt when every command fails', async () => {
    const { service, client } = makeService();

    client.failing = true;

    await expect(service.assertAllowed(ADDRESS)).resolves.toBeNull();
    await expect(service.registerFailure(ADDRESS)).resolves.toBeNull();
    await expect(service.reset(ADDRESS)).resolves.toBeUndefined();
  });

  /**
   * Null, not a guess: a standing this process does not know must not be
   * stated, or the form would count down a block nobody is serving.
   */
  it('allows the attempt on an answer it cannot read', async () => {
    const { service, client } = makeService();

    client.replies.authThrottleAttempt = ['nonsense'];
    client.replies.authThrottleFailure = ['nonsense'];

    await expect(service.assertAllowed(ADDRESS)).resolves.toBeNull();
    await expect(service.registerFailure(ADDRESS)).resolves.toBeNull();
  });
});
