import 'reflect-metadata';

import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Observable, firstValueFrom, of, throwError } from 'rxjs';

import { AuthThrottleInterceptor } from '~domain/auth/interceptors';
import type { AuthThrottleService } from '~domain/auth/services/auth-throttle.service';
import {
  NotAuthenticatedError,
  NotAuthorizedError,
  ServerError,
  TooManyRequestsError,
} from '~errors';

const ADDRESS = '203.0.113.7';

/**
 * What the interceptor asked the throttle to do, in order.
 */
interface Calls {
  allowed: string[];
  failures: string[];
  resets: string[];
}

/**
 * Builds a throttle that records its calls, optionally refusing the check.
 *
 * @param refuseWithMs - When set, `assertAllowed` refuses with this wait.
 * @returns The stub and the record of what it was asked.
 */
function makeThrottle(refuseWithMs?: number): {
  throttle: AuthThrottleService;
  calls: Calls;
} {
  const calls: Calls = { allowed: [], failures: [], resets: [] };

  const throttle = {
    assertAllowed: (address: string): Promise<void> => {
      calls.allowed.push(address);

      if (refuseWithMs) {
        return Promise.reject(
          new TooManyRequestsError('Too many login attempts, retry in 5 s', {
            retryAfterMs: refuseWithMs,
          }),
        );
      }

      return Promise.resolve();
    },
    registerFailure: (address: string): Promise<void> => {
      calls.failures.push(address);

      return Promise.resolve();
    },
    reset: (address: string): Promise<void> => {
      calls.resets.push(address);

      return Promise.resolve();
    },
  } as unknown as AuthThrottleService;

  return { throttle, calls };
}

/**
 * An execution context carrying the address the client-ip hook resolved.
 *
 * @returns The context the interceptor reads.
 */
function makeContext(): ExecutionContext {
  const request = { ip: '127.0.0.1', ctx: { ip: ADDRESS }, headers: {} };

  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: (): object => request,
      getResponse: (): object => ({}),
    }),
  } as unknown as ExecutionContext;
}

/**
 * A handler that answers, or fails with the given error.
 *
 * @param outcome - What the handler should do.
 * @returns The call handler.
 */
function makeHandler(outcome: unknown): CallHandler {
  return {
    handle: (): Observable<unknown> =>
      outcome instanceof Error
        ? throwError(() => outcome)
        : of(outcome),
  };
}

/**
 * Runs the interceptor over one handler outcome.
 *
 * @param interceptor - The interceptor under test.
 * @param outcome - What the handler answers or throws.
 * @returns What the caller receives.
 */
function run(
  interceptor: AuthThrottleInterceptor,
  outcome: unknown,
): Promise<unknown> {
  return firstValueFrom(
    interceptor.intercept(makeContext(), makeHandler(outcome)),
  );
}

describe('AuthThrottleInterceptor — the outcome it records', () => {
  it('clears the ladder when the handler answers', async () => {
    const { throttle, calls } = makeThrottle();
    const interceptor = new AuthThrottleInterceptor(throttle);

    await expect(run(interceptor, { access: 'token' })).resolves.toEqual({
      access: 'token',
    });

    expect(calls).toEqual({
      allowed: [ADDRESS],
      failures: [],
      resets: [ADDRESS],
    });
  });

  /**
   * On the login path `NotAuthenticatedError` has exactly one source: the
   * branch where the password does not verify.
   */
  it('records a failure on a wrong password', async () => {
    const { throttle, calls } = makeThrottle();
    const interceptor = new AuthThrottleInterceptor(throttle);

    await expect(run(interceptor, new NotAuthenticatedError('nope')))
      .rejects.toBeInstanceOf(NotAuthenticatedError);

    expect(calls.failures).toEqual([ADDRESS]);
    expect(calls.resets).toEqual([]);
  });

  /**
   * A deactivated account answered `NotAuthorizedError`, which means the
   * password was right — no guess to count.
   */
  it('records nothing for a deactivated account', async () => {
    const { throttle, calls } = makeThrottle();
    const interceptor = new AuthThrottleInterceptor(throttle);

    await expect(run(interceptor, new NotAuthorizedError()))
      .rejects.toBeInstanceOf(NotAuthorizedError);

    expect(calls.failures).toEqual([]);
    expect(calls.resets).toEqual([]);
  });

  it('records nothing when the failure is the server’s own', async () => {
    const { throttle, calls } = makeThrottle();
    const interceptor = new AuthThrottleInterceptor(throttle);

    await expect(run(interceptor, new ServerError('database is down')))
      .rejects.toBeInstanceOf(ServerError);

    expect(calls.failures).toEqual([]);
  });
});

describe('AuthThrottleInterceptor — the refusal', () => {
  it('never reaches the handler', async () => {
    const { throttle } = makeThrottle(5000);
    const interceptor = new AuthThrottleInterceptor(throttle);
    const handle = jest.fn();

    await expect(
      firstValueFrom(
        interceptor.intercept(makeContext(), { handle } as CallHandler),
      ),
    ).rejects.toBeInstanceOf(TooManyRequestsError);

    expect(handle).not.toHaveBeenCalled();
  });

  /**
   * Its own refusal must not be mistaken for a wrong password, or a caller
   * hammering a closed door would keep climbing the ladder while serving a
   * penalty.
   */
  it('is not counted as a failed attempt', async () => {
    const { throttle, calls } = makeThrottle(5000);
    const interceptor = new AuthThrottleInterceptor(throttle);

    await expect(run(interceptor, { access: 'token' })).rejects
      .toBeInstanceOf(TooManyRequestsError);

    expect(calls.failures).toEqual([]);
    expect(calls.resets).toEqual([]);
  });
});
