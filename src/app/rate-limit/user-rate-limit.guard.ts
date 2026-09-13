import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RateLimitConfig } from '~config';
import {
  HEADER_RATE_LIMIT,
  HEADER_RATE_LIMIT_REMAINING,
  HEADER_RATE_LIMIT_RESET,
  HEADER_RATE_LIMIT_RETRY_MS,
  HEADER_RETRY_AFTER,
  RATE_LIMIT_META_INJECT_TOKEN,
  RATE_LIMIT_SKIP_META_INJECT_TOKEN,
} from '~constants';
import { RateLimitProfile } from '~enums';
import { TooManyRequestsError } from '~errors';
import type { RateLimitCharge, RateLimitDecision, Response } from '~types';

import { ContextManager } from '../context';
import { RateLimitStore } from './rate-limit.store';

/**
 * Milliseconds in a second, for rendering `Retry-After` in the whole seconds
 * RFC 9110 requires of it.
 */
const MS_PER_SEC = 1000;

/**
 * Message a refused request is answered with. It states the rule rather than
 * the caller's position in it — a client only needs to know to back off, and
 * the headers say for how long.
 */
const REFUSED_MESSAGE = 'Too many requests, retry after the stated delay';

/**
 * Per-caller request-rate cap, applied to every route.
 *
 * Registered as a global guard **after** `AuthJwtGuard`, which is what makes
 * the bucket per account rather than per address: an authenticated caller is
 * keyed by user id, so opening a second browser or moving to another network
 * buys nothing. Anonymous traffic falls back to the address.
 *
 * Two buckets can be charged. Every request pays the global rule; a route
 * carrying `@RateLimit(profile)` also pays that profile's bucket, keyed by
 * its controller. The buckets are separate on purpose — a tightened
 * controller must not spend the caller's allowance for the rest of the API,
 * nor have its own allowance spent by it.
 *
 * One gap worth stating, because it follows from the ordering above: a
 * request rejected by `AuthJwtGuard` — an expired or forged token — never
 * reaches this guard and so is never counted. Bounding that flood is the
 * reverse proxy's job; what this guard bounds is what an account can make
 * the database do.
 */
@Injectable()
export class UserRateLimitGuard implements CanActivate {
  /**
   * Picks the decision the response should describe: a refusal always wins,
   * and between allowances the one with least headroom is the one a client
   * needs to pace itself against.
   *
   * @param decisions - What each charged bucket answered, in order.
   * @returns The decision to report, or null when nothing was charged.
   */
  private static pick(
    decisions: RateLimitDecision[],
  ): RateLimitDecision | null {
    const refused = decisions.find((decision) => !decision.allowed);

    if (refused) {
      return refused;
    }

    return decisions.reduce<RateLimitDecision | null>(
      (narrowest, decision) =>
        narrowest && narrowest.remaining < decision.remaining
          ? narrowest
          : decision,
      null,
    );
  }

  public constructor(
    private readonly config: RateLimitConfig,
    private readonly store: RateLimitStore,
    private readonly reflector: Reflector,
  ) {}

  /**
   * Charges the request and either lets it through or refuses it, having
   * stated the caller's standing in the response headers either way.
   *
   * @param context - The execution context of the current request.
   * @returns True when the request may proceed.
   * @throws {TooManyRequestsError} When a bucket had no token left.
   */
  public async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.config.enabled || context.getType() !== 'http') {
      return true;
    }

    if (this.exempt(context)) {
      return true;
    }

    const decisions = await this.store.consume(this.charges(context));
    const decision = UserRateLimitGuard.pick(decisions);

    /**
     * Nothing was charged, so the store could not answer: fail open and say
     * nothing about a standing this process does not know.
     */
    if (!decision) {
      return true;
    }

    this.report(context, decision);

    if (!decision.allowed) {
      throw new TooManyRequestsError(REFUSED_MESSAGE, {
        retryAfterMs: decision.retryAfterMs,
      });
    }

    return true;
  }

  /**
   * Whether this route is out of the limiter entirely.
   *
   * One route is: the liveness probe. Every replica is probed from the
   * balancer's single address against buckets shared by the whole fleet, so
   * a refused probe would drain every replica at once — see
   * `@NoRateLimit()`.
   *
   * @param context - The execution context of the current request.
   * @returns True when the route opted out.
   */
  private exempt(context: ExecutionContext): boolean {
    return this.reflector.getAllAndOverride<boolean | undefined>(
      RATE_LIMIT_SKIP_META_INJECT_TOKEN,
      [context.getHandler(), context.getClass()],
    ) === true;
  }

  /**
   * Lists the buckets this request owes, in the order they apply.
   *
   * @param context - The execution context of the current request.
   * @returns The global charge, plus the route profile's when it declares
   *   one.
   */
  private charges(context: ExecutionContext): RateLimitCharge[] {
    const tracker = this.tracker(context);
    const global: RateLimitCharge = {
      key: `global:${tracker}`,
      rule: this.config.globalRule,
    };

    const profile = this.reflector.getAllAndOverride<
      RateLimitProfile | undefined
    >(RATE_LIMIT_META_INJECT_TOKEN, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!profile) {
      return [global];
    }

    return [
      global,
      {
        key: `${profile}:${context.getClass().name}:${tracker}`,
        rule: this.config.ruleFor(profile),
      },
    ];
  }

  /**
   * Derives the caller's bucket identity, preferring the authenticated user
   * id over the source address.
   *
   * The address is whatever `ContextModule`'s middleware resolved for this
   * request — the last hop of a header the deployment trusts, or the
   * connection's own. That resolution deliberately lives there and not here:
   * a bucket key a caller can choose bounds nothing, and two copies of the
   * rule are two chances for one of them to be the lenient one.
   *
   * @param context - The execution context of the current request.
   * @returns `user:<id>` when authenticated, else `ip:<address>`.
   */
  private tracker(context: ExecutionContext): string {
    const manager = ContextManager.create(context);
    const userId = manager.user?.id;

    if (userId) {
      return `user:${userId}`;
    }

    return `ip:${manager.manager.ip}`;
  }

  /**
   * States the caller's standing in the response headers, on an allowed
   * request as much as on a refused one — a client that only learns the
   * limit by hitting it cannot avoid hitting it.
   *
   * @param context - The execution context of the current request.
   * @param decision - The decision to describe.
   */
  private report(
    context: ExecutionContext,
    decision: RateLimitDecision,
  ): void {
    const reply = context.switchToHttp().getResponse<Response>();

    reply.header(HEADER_RATE_LIMIT, decision.limit);
    reply.header(HEADER_RATE_LIMIT_REMAINING, decision.remaining);
    reply.header(
      HEADER_RATE_LIMIT_RESET,
      Math.ceil(decision.retryAfterMs / MS_PER_SEC),
    );

    if (decision.allowed) {
      return;
    }

    reply.header(
      HEADER_RETRY_AFTER,
      Math.max(1, Math.ceil(decision.retryAfterMs / MS_PER_SEC)),
    );
    reply.header(HEADER_RATE_LIMIT_RETRY_MS, decision.retryAfterMs);
  }
}
