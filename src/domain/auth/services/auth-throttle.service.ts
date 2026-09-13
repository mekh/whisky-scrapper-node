import { Injectable, Logger } from '@nestjs/common';

import {
  LOGIN_ATTEMPTS_PER_STAGE,
  LOGIN_ATTEMPT_MIN_INTERVAL_MS,
  LOGIN_PENALTY_SECONDS,
  LOGIN_THROTTLE_RETENTION_SEC,
} from '~constants';
import { TooManyRequestsError } from '~errors';
import {
  ValkeyClient,
  ValkeyCluster,
  ValkeyScript,
  ValkeyService,
} from '~lib/valkey';
import type { LoginThrottleDecision } from '~types';

import {
  AUTH_THROTTLE_ATTEMPT_COMMAND,
  AUTH_THROTTLE_ATTEMPT_SCRIPT,
  AUTH_THROTTLE_FAILURE_COMMAND,
  AUTH_THROTTLE_FAILURE_SCRIPT,
} from './auth-throttle.script';

/**
 * Milliseconds in a second, for turning the ladder's stamps into a
 * `Retry-After`.
 */
const MS_PER_SEC = 1000;

/**
 * Progressive throttle on login attempts: five failures buy a wait, and each
 * wait is longer than the last.
 *
 * It sits **in front of the password verification** rather than in a guard,
 * and that is the point of it living here: a guard cannot know whether the
 * attempt succeeded, and a ladder that counts successes would climb under
 * ordinary use — five logins across a person's devices and the sixth waits
 * five seconds, then ten, then a minute. So only failures count, and a
 * successful login clears the state outright. The one rule that does apply
 * to every attempt is the one-per-second spacing, which nothing legitimate
 * ever notices.
 *
 * State lives in Valkey, not in this process, for one reason: a penalty
 * meant to last an hour is worth little if a deploy clears it, and deploys
 * here are frequent. Both writes are **one script call each** rather than a
 * read followed by a write — see `auth-throttle.script.ts` for the race that
 * closes. The cost is a dependency on the request path, so every failure of
 * it is **fail-open**: a cache outage must not be able to lock every account
 * out of logging in. That is the right way round, since the edge still
 * rate-limits these two routes (`limit_req` in `nginx.conf`) and the
 * application's own per-caller limiter still applies.
 */
@Injectable()
export class AuthThrottleService {
  /**
   * Reads the attempt script's answer.
   *
   * @param reply - Whatever the driver handed back.
   * @returns The decision, or null when the reply was not usable — which is
   *   read as "allow", like every other failure here.
   */
  private static decision(reply: unknown): LoginThrottleDecision | null {
    if (!Array.isArray(reply) || reply.length !== 2) {
      return null;
    }

    const [allowed, retryAfterMs] = reply as unknown[];

    if (typeof allowed !== 'number' || typeof retryAfterMs !== 'number') {
      return null;
    }

    return { allowed: allowed === 1, retryAfterMs };
  }

  private readonly logger = new Logger(AuthThrottleService.name);

  private readonly storage: ValkeyClient | ValkeyCluster;

  private readonly attempt: ValkeyScript;

  private readonly failure: ValkeyScript;

  /**
   * Key root. Deliberately not the `auth:throttle:login` the JSON-record
   * version used: the state is a hash now, and a leftover string key under
   * the same name would answer `WRONGTYPE` on every command for as long as
   * its retention lasted.
   */
  private readonly prefix = 'auth:throttle:ladder';

  public constructor(valkey: ValkeyService) {
    this.storage = valkey.getClient();

    this.attempt = new ValkeyScript(
      this.storage,
      AUTH_THROTTLE_ATTEMPT_COMMAND,
      AUTH_THROTTLE_ATTEMPT_SCRIPT,
    );

    this.failure = new ValkeyScript(
      this.storage,
      AUTH_THROTTLE_FAILURE_COMMAND,
      AUTH_THROTTLE_FAILURE_SCRIPT,
    );
  }

  /**
   * Refuses an attempt that arrives during a penalty or too soon after the
   * previous one, and records the attempt otherwise.
   *
   * @param address - The caller's resolved client address.
   * @throws {TooManyRequestsError} When the attempt may not proceed, naming
   *   the wait in seconds and carrying it in milliseconds for the client.
   */
  public async assertAllowed(address: string): Promise<void> {
    const reply = await this.guard(
      'attempt',
      () =>
        this.attempt.run([this.key(address)], [
          LOGIN_ATTEMPT_MIN_INTERVAL_MS,
          LOGIN_THROTTLE_RETENTION_SEC,
        ]),
    );

    const decision = AuthThrottleService.decision(reply);

    if (!decision || decision.allowed) {
      return;
    }

    const seconds = Math.ceil(decision.retryAfterMs / MS_PER_SEC);

    throw new TooManyRequestsError(
      `Too many login attempts, retry in ${seconds} s`,
      { retryAfterMs: decision.retryAfterMs },
    );
  }

  /**
   * Records a failed attempt, imposing the next penalty once a run of them
   * is exhausted.
   *
   * @param address - The caller's resolved client address.
   */
  public async registerFailure(address: string): Promise<void> {
    await this.guard('failure', () =>
      this.failure.run([this.key(address)], [
        LOGIN_ATTEMPTS_PER_STAGE,
        LOGIN_THROTTLE_RETENTION_SEC,
        ...LOGIN_PENALTY_SECONDS,
      ]));
  }

  /**
   * Clears a caller's ladder after a successful login, which is what keeps
   * ordinary use from ever climbing it.
   *
   * @param address - The caller's resolved client address.
   */
  public async reset(address: string): Promise<void> {
    await this.guard('reset', () => this.storage.del(this.key(address)));
  }

  /**
   * Runs one cache command, turning any failure into a warning and a null.
   *
   * Fail-open is the deliberate choice: this throttle protects a password
   * from being guessed, and a cache that cannot answer must not become a
   * cache that refuses every login.
   *
   * @param operation - Name of the command, for the warning.
   * @param command - The command to run.
   * @returns The command's result, or null when it failed.
   */
  private async guard<T>(
    operation: string,
    command: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await command();
    } catch (error) {
      this.logger.warn(
        'Login throttle %s failed, allowing the attempt: %o',
        operation,
        error,
      );

      return null;
    }
  }

  /**
   * The cache key one caller's ladder is stored under.
   *
   * @param address - The caller's resolved client address.
   * @returns The namespaced key.
   */
  private key(address: string): string {
    return `${this.prefix}:${address}`;
  }
}
