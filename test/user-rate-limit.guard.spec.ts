import 'reflect-metadata';

import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RateLimitStore, UserRateLimitGuard } from '~app/rate-limit';
import type { RateLimitConfig } from '~config';
import { RATE_LIMIT_SKIP_META_INJECT_TOKEN } from '~constants';
import { RateLimitProfile } from '~enums';
import { TooManyRequestsError } from '~errors';
import type { CtxUser, ID, RateLimitCharge, RateLimitDecision } from '~types';

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
 * a smaller profile one, so the two can be told apart by their limits.
 */
const CONFIG = {
  enabled: true,
  ratePerSec: 1,
  burst: 4,
  strictRatePerSec: 1,
  strictBurst: 2,
  timeoutMs: 250,
  globalRule: { ratePerSec: 1, burst: 4 },
  ruleFor: (profile: RateLimitProfile) =>
    profile === RateLimitProfile.HEAVY
      ? { ratePerSec: 1, burst: 60 }
      : { ratePerSec: 1, burst: 2 },
} as unknown as RateLimitConfig;

/**
 * A store that records what it was asked to charge and answers what the test
 * told it to.
 *
 * The bucket arithmetic itself lives in Valkey now and is exercised against a
 * live one in `test/integration/rate-limit.integration.spec.ts`; what is left
 * here is the guard's own job — which buckets a request owes, which decision
 * is reported, and what the headers say.
 */
class StubStore {
  public charged: RateLimitCharge[][] = [];

  public constructor(
    private readonly answer: (
      charges: RateLimitCharge[],
    ) => RateLimitDecision[],
  ) {}

  /**
   * Records the charges and answers the scripted decisions.
   *
   * @param charges - The buckets the guard wants charged.
   * @returns Whatever the test's script says.
   */
  public async consume(
    charges: RateLimitCharge[],
  ): Promise<RateLimitDecision[]> {
    this.charged.push(charges);

    return this.answer(charges);
  }
}

/**
 * A decision with the fields a test does not care about filled in.
 *
 * @param overrides - What this decision should say.
 * @returns The decision.
 */
function decision(
  overrides: Partial<RateLimitDecision> = {},
): RateLimitDecision {
  return {
    allowed: true,
    limit: 4,
    remaining: 3,
    retryAfterMs: 0,
    ...overrides,
  };
}

/**
 * Builds an execution context the guard can read: a request carrying the
 * authenticated user (or not), and a reply that records its headers.
 *
 * @param options - Whether the caller is authenticated, which controller is
 *   being hit, and the resolved client address.
 * @returns The context plus the headers map the reply writes into.
 */
function makeContext(options: {
  user?: CtxUser;
  controller?: string;
  clientIp?: string;
}): { context: ExecutionContext; headers: Headers } {
  const headers: Headers = {};

  /**
   * `ctx.ip` is what `ContextModule`'s hook writes after resolving the
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
 * Builds the guard over a stubbed store.
 *
 * @param options - The profile every route declares, the answer the store
 *   gives, and whether limiting is on.
 * @returns The guard and the store it was built over.
 */
function makeGuard(options: {
  profile?: RateLimitProfile;
  answer?: (charges: RateLimitCharge[]) => RateLimitDecision[];
  config?: RateLimitConfig;
} = {}): { guard: UserRateLimitGuard; store: StubStore } {
  const reflector = {
    getAllAndOverride: (): RateLimitProfile | undefined => options.profile,
  } as unknown as Reflector;

  const fallback = (charges: RateLimitCharge[]): RateLimitDecision[] =>
    charges.map(() => decision());

  const store = new StubStore(options.answer ?? fallback);

  const guard = new UserRateLimitGuard(
    options.config ?? CONFIG,
    store as unknown as RateLimitStore,
    reflector,
  );

  return { guard, store };
}

describe('UserRateLimitGuard — which buckets a request owes', () => {
  it('charges the global bucket, keyed by the account', async () => {
    const { guard, store } = makeGuard();
    const { context } = makeContext({ user: USER });

    await guard.canActivate(context);

    expect(store.charged[0]).toEqual([
      { key: `global:user:${USER.id}`, rule: CONFIG.globalRule },
    ]);
  });

  /**
   * The reason the guard is registered after `AuthJwtGuard`: the bucket is
   * the account, so a second browser or a new address buys nothing. An
   * anonymous caller falls back to the address `ContextModule` resolved.
   */
  it('falls back to the resolved address when anonymous', async () => {
    const { guard, store } = makeGuard();
    const { context } = makeContext({ clientIp: '203.0.113.7' });

    await guard.canActivate(context);

    expect(store.charged[0]?.[0]?.key).toBe('global:ip:203.0.113.7');
  });

  /**
   * The profile bucket is separate from the global one and keyed by the
   * controller, so a tightened route neither spends the caller's allowance
   * for the rest of the API nor shares a budget with another route.
   */
  it('adds the route profile bucket, keyed by its controller', async () => {
    const { guard, store } = makeGuard({ profile: RateLimitProfile.STRICT });
    const { context } = makeContext({
      user: USER,
      controller: 'CollectionController',
    });

    await guard.canActivate(context);

    expect(store.charged[0]).toEqual([
      { key: `global:user:${USER.id}`, rule: CONFIG.globalRule },
      {
        key: `strict:CollectionController:user:${USER.id}`,
        rule: { ratePerSec: 1, burst: 2 },
      },
    ]);
  });
});

describe('UserRateLimitGuard — the answer it reports', () => {
  it('states the standing on an allowed request', async () => {
    const { guard } = makeGuard();
    const { context, headers } = makeContext({ user: USER });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(headers['X-RateLimit-Limit']).toBe(4);
    expect(headers['X-RateLimit-Remaining']).toBe(3);
    expect(headers['Retry-After']).toBeUndefined();
  });

  it('reports the bucket with the least headroom left', async () => {
    const { guard } = makeGuard({
      profile: RateLimitProfile.STRICT,
      answer: () => [
        decision({ limit: 4, remaining: 3 }),
        decision({ limit: 2, remaining: 1 }),
      ],
    });

    const { context, headers } = makeContext({ user: USER });

    await guard.canActivate(context);

    expect(headers['X-RateLimit-Limit']).toBe(2);
    expect(headers['X-RateLimit-Remaining']).toBe(1);
  });

  it('refuses with a 429 error when a bucket had nothing left', async () => {
    const { guard } = makeGuard({
      answer: () => [
        decision({ allowed: false, remaining: 0, retryAfterMs: 340 }),
      ],
    });

    const { context } = makeContext({ user: USER });

    await expect(guard.canActivate(context))
      .rejects.toThrow(TooManyRequestsError);
  });

  /**
   * `Retry-After` is whole seconds because RFC 9110 says so, and the
   * millisecond variant rides beside it so a client waiting for a 340 ms
   * refill does not idle for a whole second.
   */
  it('states both retry headers on a refusal', async () => {
    const { guard } = makeGuard({
      answer: () => [
        decision({ allowed: false, remaining: 0, retryAfterMs: 340 }),
      ],
    });

    const { context, headers } = makeContext({ user: USER });

    await expect(guard.canActivate(context)).rejects.toThrow();

    expect(headers['Retry-After']).toBe(1);
    expect(headers['X-RateLimit-Retry-After-Ms']).toBe(340);
    expect(headers['X-RateLimit-Remaining']).toBe(0);
  });

  /**
   * A refusal outranks an allowance however much headroom the other bucket
   * reports, since the request is not going through either way.
   */
  it('reports the refusal rather than the roomier bucket', async () => {
    const { guard } = makeGuard({
      profile: RateLimitProfile.STRICT,
      answer: () => [
        decision({ limit: 4, remaining: 3 }),
        decision({ allowed: false, limit: 2, remaining: 0, retryAfterMs: 90 }),
      ],
    });

    const { context, headers } = makeContext({ user: USER });

    await expect(guard.canActivate(context)).rejects.toThrow();

    expect(headers['X-RateLimit-Limit']).toBe(2);
  });
});

describe('UserRateLimitGuard — when it cannot count', () => {
  /**
   * Fail-open: a store that cannot answer must not become an API that
   * refuses every request. It reports no standing either, rather than a
   * headroom this process does not know.
   */
  it('lets the request through when nothing was charged', async () => {
    const { guard } = makeGuard({ answer: () => [] });
    const { context, headers } = makeContext({ user: USER });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(Object.keys(headers)).toHaveLength(0);
  });

  /**
   * The liveness probe. Every replica is probed from the balancer's one
   * address against buckets the fleet shares, so a refused probe would read
   * as an unhealthy replica and drain all of them at once.
   */
  it('charges nothing on a route that opted out', async () => {
    const reflector = {
      getAllAndOverride: (token: string): unknown =>
        token === RATE_LIMIT_SKIP_META_INJECT_TOKEN ? true : undefined,
    } as unknown as Reflector;

    const store = new StubStore(() => [decision({ allowed: false })]);

    const guard = new UserRateLimitGuard(
      CONFIG,
      store as unknown as RateLimitStore,
      reflector,
    );

    const { context, headers } = makeContext({ user: USER });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(store.charged).toHaveLength(0);
    expect(Object.keys(headers)).toHaveLength(0);
  });

  it('charges nothing when disabled', async () => {
    const disabled = { ...CONFIG, enabled: false } as RateLimitConfig;
    const { guard, store } = makeGuard({ config: disabled });
    const { context, headers } = makeContext({ user: USER });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(store.charged).toHaveLength(0);
    expect(Object.keys(headers)).toHaveLength(0);
  });
});
