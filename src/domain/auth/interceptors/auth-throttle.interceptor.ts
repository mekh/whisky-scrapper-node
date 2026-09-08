import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, from, map, mergeMap, throwError } from 'rxjs';

import { ContextManager } from '~app/context';
import { NotAuthenticatedError } from '~errors';

import { AuthThrottleService } from '../services/auth-throttle.service';

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
 * Two details worth knowing. Pipes run **after** interceptors, so a request
 * with a malformed body reaches the throttle before validation rejects it:
 * it counts toward the one-per-second spacing but never as a failed guess.
 * And the refusal this interceptor itself raises is a `TooManyRequestsError`,
 * so it cannot be mistaken for a wrong password by the branch below.
 */
@Injectable()
export class AuthThrottleInterceptor implements NestInterceptor {
  public constructor(private readonly throttle: AuthThrottleService) {}

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

    return from(this.throttle.assertAllowed(address)).pipe(
      mergeMap(() => next.handle()),
      mergeMap((answer: unknown) => this.onSuccess(address, answer)),
      catchError((error: unknown) => this.onFailure(address, error)),
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
    return from(this.throttle.reset(address)).pipe(map(() => answer));
  }

  /**
   * Records a wrong password and re-raises, or re-raises anything else
   * untouched.
   *
   * The recording is awaited before the error propagates, so the response a
   * caller receives is never ahead of the state it was counted against.
   *
   * @param address - The caller's resolved client address.
   * @param error - What the handler threw.
   * @returns A stream that fails with the same error.
   */
  private onFailure(address: string, error: unknown): Observable<never> {
    if (!(error instanceof NotAuthenticatedError)) {
      return throwError(() => error);
    }

    return from(this.throttle.registerFailure(address)).pipe(
      mergeMap(() => throwError(() => error)),
    );
  }
}
