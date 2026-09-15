import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, from, map, mergeMap, throwError } from 'rxjs';

import { ContextManager } from '~app/context';
import {
  HEADER_LOGIN_ATTEMPTS,
  HEADER_LOGIN_ATTEMPTS_REMAINING,
  HEADER_LOGIN_RETRY_MS,
  LOGIN_PENALTY_SECONDS,
} from '~constants';
import { NotAuthenticatedError, TooManyRequestsError } from '~errors';
import { PlatformMetricsService } from '~lib/metrics';
import type { LoginThrottleStanding, Response } from '~types';

import { AuthThrottleService } from '../services/auth-throttle.service';

/**
 * Milliseconds in a second, for reading a rung out of the wait it imposes.
 */
const MS_PER_SEC = 1000;

/**
 * Drives the progressive login throttle around the login handler: refuses
 * before it runs, and records the outcome after.
 *
 * An interceptor is the right hook because it is the only one that sees
 * both halves. Its pre-handler phase runs before the controller and
 * therefore before the Argon2 verification, which is the half that matters
 * for cost — a check that ran afterwards would leave every guess's CPU time
 * payable. Its post-handler phase sees what the handler answered, which is
 * the half a guard cannot see at all and the reason this logic used to be
 * threaded through three branches of `AuthService.login`.
 *
 * **A failure is `NotAuthenticatedError` and nothing else.** On the login
 * path that error has exactly one source, the branch where the password does
 * not verify: a deactivated account answers `NotAuthorizedError` (the
 * password was right, so it is no guess), and anything else — the cache, the
 * database — is not evidence about the caller. Adding another
 * `NotAuthenticatedError` throw to this path would silently start counting
 * it, which is the one thing to keep in mind when editing the login flow.
 *
 * It is also the one place that can **state** the ladder's standing, and for
 * the same reason: the count a person is shown comes from the write that
 * happens after the handler, while the deadline comes from the check before
 * it. A guard could write neither. The headers go on the `401` as much as on
 * the `429`, because the whole point is a door seen closing rather than one
 * reported shut.
 *
 * Two details worth knowing. Pipes run **after** interceptors, so a request
 * with a malformed body reaches the throttle before validation rejects it:
 * it counts toward the one-per-second spacing but never as a failed guess.
 * And the refusal this interceptor itself raises is a `TooManyRequestsError`,
 * so it cannot be mistaken for a wrong password by the branch below.
 */
@Injectable()
export class AuthThrottleInterceptor implements NestInterceptor {
  /**
   * Reads the standing a refusal carries, when it is one of ours.
   *
   * Written as a read of the error's data rather than a type test on the
   * error alone: `UserRateLimitGuard` raises the same class, and although a
   * guard runs before any interceptor and so cannot reach this one today,
   * a refusal with no standing in it is not one this can describe.
   *
   * @param error - The error being answered.
   * @returns The standing, or null when the error carries none.
   */
  private static standingOf(error: unknown): LoginThrottleStanding | null {
    if (!(error instanceof TooManyRequestsError)) {
      return null;
    }

    const { standing } = error.data as { standing?: LoginThrottleStanding } ??
      {};

    return standing ?? null;
  }

  public constructor(
    private readonly throttle: AuthThrottleService,
    private readonly metrics: PlatformMetricsService,
  ) {}

  /**
   * Wraps the handler in the throttle's check and its bookkeeping.
   *
   * @param context - The execution context of the current request.
   * @param next - The rest of the chain.
   * @returns The handler's stream, or a refusal in place of it.
   */
  public intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const address = ContextManager.create(context).manager.ip;
    const reply = context.switchToHttp().getResponse<Response>();

    return from(this.throttle.assertAllowed(address)).pipe(
      mergeMap(() => next.handle()),
      mergeMap((answer: unknown) => this.onSuccess(address, answer)),
      catchError((error: unknown) => this.onFailure(address, reply, error)),
    );
  }

  /**
   * Clears the caller's ladder, which is what keeps ordinary use from ever
   * climbing it, and passes the answer through untouched.
   *
   * @param address - The caller's resolved client address.
   * @param answer - What the handler returned.
   * @returns The same answer, once the reset is written.
   */
  private onSuccess(address: string, answer: unknown): Observable<unknown> {
    this.metrics.login('success');

    return from(this.throttle.reset(address)).pipe(map(() => answer));
  }

  /**
   * Records a wrong password and re-raises, describing where the caller now
   * stands; re-raises anything else untouched, save for its own refusal,
   * which describes itself.
   *
   * The recording is awaited before the error propagates, so the response a
   * caller receives is never ahead of the state it was counted against.
   *
   * @param address - The caller's resolved client address.
   * @param reply - The reply being built.
   * @param error - What the handler threw.
   * @returns A stream that fails with the same error.
   */
  private onFailure(
    address: string,
    reply: Response,
    error: unknown,
  ): Observable<never> {
    const refusal = AuthThrottleInterceptor.standingOf(error);

    if (refusal) {
      this.metrics.login('throttled');
      this.describe(reply, refusal);

      return throwError(() => error);
    }

    if (!(error instanceof NotAuthenticatedError)) {
      return throwError(() => error);
    }

    this.metrics.login('failed');

    return from(this.throttle.registerFailure(address)).pipe(
      mergeMap((standing: LoginThrottleStanding | null) => {
        this.countPenalty(standing);
        this.describe(reply, standing);

        return throwError(() => error);
      }),
    );
  }

  /**
   * Counts a penalty the failure just bought, and only then.
   *
   * The rung is read from the wait the ladder came back with rather than
   * tracked separately, so the counter cannot disagree with the delay the
   * caller was actually told to observe.
   *
   * @param standing - Where the caller now stands, or null when unknown.
   */
  private countPenalty(standing: LoginThrottleStanding | null): void {
    if (!standing || standing.blockedForMs <= 0) {
      return;
    }

    const stage = LOGIN_PENALTY_SECONDS.findIndex(
      (seconds) => seconds * MS_PER_SEC >= standing.blockedForMs,
    );

    this.metrics.loginPenalty(
      stage === -1 ? LOGIN_PENALTY_SECONDS.length - 1 : stage,
    );
  }

  /**
   * States the caller's standing on the ladder in the response headers.
   *
   * Nothing is written when the ladder could not say — a cache outage fails
   * open, and a client told "four attempts left" by a process that does not
   * know would be worse served than one told nothing.
   *
   * @param reply - The reply being built.
   * @param standing - Where the caller stands, or null when unknown.
   */
  private describe(
    reply: Response,
    standing: LoginThrottleStanding | null,
  ): void {
    if (!standing) {
      return;
    }

    reply.header(HEADER_LOGIN_ATTEMPTS, standing.limit);
    reply.header(HEADER_LOGIN_ATTEMPTS_REMAINING, standing.remaining);

    if (standing.blockedForMs > 0) {
      reply.header(HEADER_LOGIN_RETRY_MS, standing.blockedForMs);
    }
  }
}
