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
import type { LoginThrottleStanding } from '~types';

const ADDRESS = '203.0.113.7';

/**
 * A standing the stubs report unless a test asks for another.
 */
const STANDING: LoginThrottleStanding = {
  limit: 5,
  remaining: 3,
  blockedForMs: 0,
};

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
 * @param standing - What the throttle reports, or null for a cache that
 *   could not say.
 * @returns The stub and the record of what it was asked.
 */
function makeThrottle(
  refuseWithMs?: number,
  standing: LoginThrottleStanding | null = STANDING,
): {
  throttle: AuthThrottleService;
  calls: Calls;
} {
  const calls: Calls = { allowed: [], failures: [], resets: [] };

  const throttle = {
    assertAllowed: (
      address: string,
    ): Promise<LoginThrottleStanding | null> => {
      calls.allowed.push(address);

      if (refuseWithMs) {
        return Promise.reject(
          new TooManyRequestsError('Too many login attempts, retry in 5 s', {
            retryAfterMs: refuseWithMs,
            standing: standing
              ? { ...standing, blockedForMs: refuseWithMs }
              : undefined,
          }),
        );
      }

      return Promise.resolve(standing);
    },
    registerFailure: (
      address: string,
    ): Promise<LoginThrottleStanding | null> => {
      calls.failures.push(address);

      return Promise.resolve(standing);
    },
    reset: (address: string): Promise<void> => {
      calls.resets.push(address);

      return Promise.resolve();
    },
  } as unknown as AuthThrottleService;

  return { throttle, calls };
}

/**
 * The headers one reply was given, in the order they were set.
 */
type Written = Record<string, unknown>;

/**
 * An execution context carrying the address the client-ip hook resolved,
 * over a reply that records what is written to it.
 *
 * @param written - The map the reply records its headers into.
 * @returns The context the interceptor reads.
 */
function makeContext(written: Written = {}): ExecutionContext {
  const request = { ip: '127.0.0.1', ctx: { ip: ADDRESS }, headers: {} };
  const reply = {
    header: (name: string, value: unknown): void => {
      written[name] = value;
    },
  };

  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: (): object => request,
      getResponse: (): object => reply,
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
  written: Written = {},
): Promise<unknown> {
  return firstValueFrom(
    interceptor.intercept(makeContext(written), makeHandler(outcome)),
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

/**
 * The headers `../web`'s login form reads. They are written here and not in
 * a guard because only this hook sees both the check that precedes the
 * handler and the write that follows it.
 */
describe('AuthThrottleInterceptor — the standing it states', () => {
  it('states the run and what is left of it on a wrong password', async () => {
    const { throttle } = makeThrottle();
    const interceptor = new AuthThrottleInterceptor(throttle);
    const written: Written = {};

    await expect(run(interceptor, new NotAuthenticatedError('nope'), written))
      .rejects.toBeInstanceOf(NotAuthenticatedError);

    expect(written).toEqual({
      'X-Login-Attempts': 5,
      'X-Login-Attempts-Remaining': 3,
    });
  });

  /**
   * The failure that exhausts a run answers `401` and imposes the wait in
   * the same breath, so that one response has to carry both.
   */
  it('states the penalty a failure imposed, on the 401', async () => {
    const { throttle } = makeThrottle(undefined, {
      limit: 5,
      remaining: 5,
      blockedForMs: 5000,
    });
    const interceptor = new AuthThrottleInterceptor(throttle);
    const written: Written = {};

    await expect(run(interceptor, new NotAuthenticatedError('nope'), written))
      .rejects.toBeInstanceOf(NotAuthenticatedError);

    expect(written['X-Login-Retry-After-Ms']).toBe(5000);
  });

  it('states the wait on its own refusal', async () => {
    const { throttle } = makeThrottle(5000);
    const interceptor = new AuthThrottleInterceptor(throttle);
    const written: Written = {};

    await expect(run(interceptor, { access: 'token' }, written))
      .rejects.toBeInstanceOf(TooManyRequestsError);

    expect(written).toEqual({
      'X-Login-Attempts': 5,
      'X-Login-Attempts-Remaining': 3,
      'X-Login-Retry-After-Ms': 5000,
    });
  });

  /**
   * Fail-open means the ladder allowed the attempt without knowing anything,
   * and a header stating a standing this process does not have would be a
   * countdown against a block nobody is serving.
   */
  it('states nothing when the ladder could not say', async () => {
    const { throttle } = makeThrottle(undefined, null);
    const interceptor = new AuthThrottleInterceptor(throttle);
    const written: Written = {};

    await expect(run(interceptor, new NotAuthenticatedError('nope'), written))
      .rejects.toBeInstanceOf(NotAuthenticatedError);

    expect(written).toEqual({});
  });

  it('says nothing about the ladder on a success', async () => {
    const { throttle } = makeThrottle();
    const interceptor = new AuthThrottleInterceptor(throttle);
    const written: Written = {};

    await expect(run(interceptor, { access: 'token' }, written)).resolves
      .toEqual({ access: 'token' });

    expect(written).toEqual({});
  });
});
