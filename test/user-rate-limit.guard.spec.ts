import 'reflect-metadata';

import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RateLimitStore, UserRateLimitGuard } from '~app/rate-limit';
import type { RateLimitConfig } from '~config';
import { RateLimitProfile } from '~enums';
import { TooManyRequestsError } from '~errors';
import type { CtxUser, ID } from '~types';

const USER: CtxUser = {
  id: '019ff1bf-5e59-7d17-b699-b4ea1c8183ab' as ID,
  sid: 'sid',
  admin: false,
  permissions: new Map(),
};

/**
 * The headers a request collected, in the order they were set.
 */
type Headers = Record<string, unknown>;

/**
 * Config values every test in this file shares: a small global allowance and
 * a smaller profile one, so the two can be told apart by counting.
 */
const CONFIG = {
  enabled: true,
  trustProxy: true,
  ratePerSec: 1,
  burst: 4,
  heavyRatePerSec: 1,
  heavyBurst: 60,
  strictRatePerSec: 1,
  strictBurst: 2,
  maxKeys: 1000,
  sweepIntervalMs: 60000,
  globalRule: { ratePerSec: 1, burst: 4 },
  ruleFor: (profile: RateLimitProfile) =>
    profile === RateLimitProfile.HEAVY
      ? { ratePerSec: 1, burst: 60 }
      : { ratePerSec: 1, burst: 2 },
} as unknown as RateLimitConfig;

/**
 * Builds an execution context the guard can read: a request carrying the
 * authenticated user (or not), and a reply that records its headers.
 *
 * @param options - Whether the caller is authenticated, and which profile
 *   the route declares.
 * @returns The context plus the headers map the reply writes into.
 */
function makeContext(options: {
  user?: CtxUser;
  profile?: RateLimitProfile;
  controller?: string;
  clientIp?: string;
}): { context: ExecutionContext; headers: Headers } {
  const headers: Headers = {};

  /**
   * `ctx.ip` is what `ContextModule`'s middleware writes after resolving the
   * trusted headers — the guard reads that rather than resolving anything
   * itself, so a test states the resolved address directly.
   */
  const request = {
    ip: '127.0.0.1',
    ctx: {
      ...options.user ? { user: options.user } : {},
      ...options.clientIp ? { ip: options.clientIp } : {},
    },
    headers: {},
  };

  const reply = {
    header: (name: string, value: unknown): void => {
      headers[name] = value;
    },
  };

  const context = {
    getType: () => 'http',
    getHandler: () => function handler(): void {},
    getClass: () => ({ name: options.controller ?? 'TestController' }),
    switchToHttp: () => ({
      getRequest: (): object => request,
      getResponse: (): object => reply,
    }),
  } as unknown as ExecutionContext;

  return { context, headers };
}

/**
 * Builds the guard over a fresh store.
 *
 * @param profile - The profile every route in this test declares, if any.
 * @returns The guard under test.
 */
function makeGuard(profile?: RateLimitProfile): UserRateLimitGuard {
  const reflector = {
    getAllAndOverride: () => profile,
  } as unknown as Reflector;

  return new UserRateLimitGuard(CONFIG, new RateLimitStore(CONFIG), reflector);
}

/**
 * Charges a guard until it refuses, and reports how many requests it let
 * through.
 *
 * @param guard - The guard to charge.
 * @param context - The context to charge it with.
 * @param attempts - How many attempts to make.
 * @returns The number of allowed attempts.
 */
function allowedCount(
  guard: UserRateLimitGuard,
  context: ExecutionContext,
  attempts: number,
): number {
  return Array.from({ length: attempts })
    .filter(() => {
      try {
        return guard.canActivate(context);
      } catch {
        return false;
      }
    })
    .length;
}

describe('UserRateLimitGuard — the global cap', () => {
  it('lets the burst through and then refuses', () => {
    const guard = makeGuard();
    const { context } = makeContext({ user: USER });

    expect(allowedCount(guard, context, 10)).toBe(CONFIG.burst);
  });

  it('refuses with a 429 error', () => {
    const guard = makeGuard();
    const { context } = makeContext({ user: USER });

    allowedCount(guard, context, CONFIG.burst);

    expect(() => guard.canActivate(context)).toThrow(TooManyRequestsError);
  });

  /**
   * The reason the guard is registered after `AuthJwtGuard`: the bucket is
   * the account, so a second browser or a new address buys nothing.
   */
  it('buckets two callers separately', () => {
    const guard = makeGuard();
    const mine = makeContext({ user: USER });
    const theirs = makeContext({});

    allowedCount(guard, mine.context, CONFIG.burst);

    expect(guard.canActivate(theirs.context)).toBe(true);
  });
});

describe('UserRateLimitGuard — the anonymous key', () => {
  it('buckets anonymous callers by their resolved address', () => {
    const guard = makeGuard();

    const one = makeContext({ clientIp: '203.0.113.7' });
    const two = makeContext({ clientIp: '203.0.113.8' });

    allowedCount(guard, one.context, CONFIG.burst);

    expect(guard.canActivate(two.context)).toBe(true);
  });

  /**
   * Which address that is — and, crucially, that a caller cannot choose it —
   * is `ClientIpUtils`' business, exercised in its own spec. The guard's
   * side of the contract is only that it reads the resolved value rather
   * than the connection's, so two callers behind one proxy stay apart.
   */
  it('does not collapse two callers onto the connection address', () => {
    const guard = makeGuard();

    const one = makeContext({ clientIp: '203.0.113.7' });

    allowedCount(guard, one.context, CONFIG.burst);

    expect(() => guard.canActivate(one.context)).toThrow(TooManyRequestsError);
    expect(guard.canActivate(makeContext({ clientIp: '198.51.100.4' }).context))
      .toBe(true);
  });
});

describe('UserRateLimitGuard — a route profile', () => {
  /**
   * The profile bucket is separate from the global one, so a controller
   * tightened to two requests refuses at two while the rest of the API
   * still has its own allowance.
   */
  it('applies the stricter profile bound', () => {
    const guard = makeGuard(RateLimitProfile.STRICT);
    const { context } = makeContext({ user: USER });

    expect(allowedCount(guard, context, 10)).toBe(2);
  });

  it('leaves other controllers their own profile bucket', () => {
    const guard = makeGuard(RateLimitProfile.STRICT);
    const one = makeContext({ user: USER, controller: 'CollectionController' });
    const two = makeContext({ user: USER, controller: 'FilterController' });

    allowedCount(guard, one.context, 2);

    expect(guard.canActivate(two.context)).toBe(true);
  });
});

describe('UserRateLimitGuard — the headers', () => {
  it('states the standing on an allowed request', () => {
    const guard = makeGuard();
    const { context, headers } = makeContext({ user: USER });

    guard.canActivate(context);

    expect(headers['X-RateLimit-Limit']).toBe(CONFIG.burst);
    expect(headers['X-RateLimit-Remaining']).toBe(CONFIG.burst - 1);
    expect(headers['Retry-After']).toBeUndefined();
  });

  it('reports the narrower of the two buckets', () => {
    const guard = makeGuard(RateLimitProfile.STRICT);
    const { context, headers } = makeContext({ user: USER });

    guard.canActivate(context);

    expect(headers['X-RateLimit-Limit']).toBe(2);
    expect(headers['X-RateLimit-Remaining']).toBe(1);
  });

  /**
   * `Retry-After` is whole seconds because RFC 9110 says so, and the
   * millisecond variant rides beside it so a client waiting for a 340 ms
   * refill does not idle for a whole second.
   */
  it('states both retry headers on a refusal', () => {
    const guard = makeGuard();
    const { context, headers } = makeContext({ user: USER });

    allowedCount(guard, context, CONFIG.burst);
    expect(() => guard.canActivate(context)).toThrow(TooManyRequestsError);

    expect(headers['Retry-After']).toBeGreaterThanOrEqual(1);
    expect(headers['X-RateLimit-Retry-After-Ms']).toBeGreaterThan(0);
    expect(headers['X-RateLimit-Remaining']).toBe(0);
  });
});

describe('UserRateLimitGuard — the off switch', () => {
  it('charges nothing when disabled', () => {
    const disabled = { ...CONFIG, enabled: false } as RateLimitConfig;
    const reflector = {
      getAllAndOverride: () => undefined,
    } as unknown as Reflector;

    const guard = new UserRateLimitGuard(
      disabled,
      new RateLimitStore(disabled),
      reflector,
    );

    const { context, headers } = makeContext({ user: USER });

    expect(allowedCount(guard, context, 50)).toBe(50);
    expect(Object.keys(headers)).toHaveLength(0);
  });
});
