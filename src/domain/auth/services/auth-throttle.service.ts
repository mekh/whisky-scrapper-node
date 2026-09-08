import { Injectable, Logger } from '@nestjs/common';

import {
  LOGIN_ATTEMPTS_PER_STAGE,
  LOGIN_ATTEMPT_MIN_INTERVAL_MS,
  LOGIN_PENALTY_SECONDS,
  LOGIN_THROTTLE_RETENTION_SEC,
} from '~constants';
import { TooManyRequestsError } from '~errors';
import { ValkeyClient, ValkeyCluster, ValkeyService } from '~lib/valkey';
import type { LoginThrottleDecision, LoginThrottleState } from '~types';

/**
 * Milliseconds in a second, for turning the ladder's seconds into stamps and
 * the stamps back into a `Retry-After`.
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
 * here are frequent. The cost is a dependency on the request path, so every
 * failure of it is **fail-open** — a cache outage must not be able to lock
 * every account out of logging in. That is the right way round: the edge
 * still rate-limits these two routes (`limit_req` in `nginx.conf`) and the
 * application's own per-caller limiter still applies, so failing open here
 * loses the ladder, not every defence.
 */
@Injectable()
export class AuthThrottleService {
  private readonly logger = new Logger(AuthThrottleService.name);

  private readonly storage: ValkeyClient | ValkeyCluster;

  private readonly prefix = 'auth:throttle:login';

  public constructor(valkey: ValkeyService) {
    this.storage = valkey.getClient();
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
    const state = await this.read(address);
    const now = Date.now();
    const decision = AuthThrottleService.decide(state, now);

    if (!decision.allowed) {
      const seconds = Math.ceil(decision.retryAfterMs / MS_PER_SEC);

      throw new TooManyRequestsError(
        `Too many login attempts, retry in ${seconds} s`,
        { retryAfterMs: decision.retryAfterMs },
      );
    }

    await this.write(address, {
      ...state ?? AuthThrottleService.fresh(),
      lastAttemptAt: now,
    });
  }

  /**
   * Records a failed attempt, imposing the next penalty once a run of them
   * is exhausted.
   *
   * @param address - The caller's resolved client address.
   */
  public async registerFailure(address: string): Promise<void> {
    const state = await this.read(address) ?? AuthThrottleService.fresh();
    const now = Date.now();
    const failures = state.failures + 1;

    if (failures < LOGIN_ATTEMPTS_PER_STAGE) {
      await this.write(address, { ...state, failures, lastAttemptAt: now });

      return;
    }

    const penaltyMs = AuthThrottleService.penaltyMs(state.stage);

    await this.write(address, {
      failures: 0,
      stage: state.stage + 1,
      blockedUntil: now + penaltyMs,
      lastAttemptAt: now,
    });
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
   * Decides whether an attempt may proceed, given the stored state.
   *
   * Pure and static so the rule can be read — and tested — without a cache:
   * a live penalty refuses for its remainder, and otherwise two attempts
   * inside one second refuse for the rest of that second.
   *
   * @param state - The caller's stored state, or null when they have none.
   * @param now - Current epoch milliseconds.
   * @returns Whether to allow the attempt, and the wait if not.
   */
  private static decide(
    state: LoginThrottleState | null,
    now: number,
  ): LoginThrottleDecision {
    if (!state) {
      return { allowed: true, retryAfterMs: 0 };
    }

    if (state.blockedUntil > now) {
      return { allowed: false, retryAfterMs: state.blockedUntil - now };
    }

    const sinceLast = now - state.lastAttemptAt;

    if (sinceLast >= 0 && sinceLast < LOGIN_ATTEMPT_MIN_INTERVAL_MS) {
      return {
        allowed: false,
        retryAfterMs: LOGIN_ATTEMPT_MIN_INTERVAL_MS - sinceLast,
      };
    }

    return { allowed: true, retryAfterMs: 0 };
  }

  /**
   * The wait one exhausted run of attempts costs at a given rung.
   *
   * @param stage - How many penalties have already been served.
   * @returns The penalty in milliseconds; the last rung repeats forever.
   */
  private static penaltyMs(stage: number): number {
    const index = Math.min(stage, LOGIN_PENALTY_SECONDS.length - 1);

    return (LOGIN_PENALTY_SECONDS[index] ?? 0) * MS_PER_SEC;
  }

  /**
   * The state a caller starts from.
   *
   * @returns A zeroed ladder.
   */
  private static fresh(): LoginThrottleState {
    return { failures: 0, stage: 0, blockedUntil: 0, lastAttemptAt: 0 };
  }

  /**
   * Reads a caller's stored state.
   *
   * @param address - The caller's resolved client address.
   * @returns The state, or null when there is none or the cache did not
   *   answer.
   */
  private async read(address: string): Promise<LoginThrottleState | null> {
    const raw = await this.guard(
      'read',
      () => this.storage.get(this.key(address)),
    );

    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as LoginThrottleState;
    } catch {
      this.logger.warn('Discarding an unreadable login throttle record');

      return null;
    }
  }

  /**
   * Stores a caller's state, refreshing its retention window.
   *
   * @param address - The caller's resolved client address.
   * @param state - The state to store.
   */
  private async write(
    address: string,
    state: LoginThrottleState,
  ): Promise<void> {
    await this.guard('write', () =>
      this.storage.set(
        this.key(address),
        JSON.stringify(state),
        'EX',
        LOGIN_THROTTLE_RETENTION_SEC,
      ));
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
