import { Injectable, Logger } from '@nestjs/common';

import { RateLimitConfig } from '~config';
import type { RateLimitBucket, RateLimitDecision, RateLimitRule } from '~types';

/**
 * Milliseconds in a second, named because the refill arithmetic reads better
 * with a name than with the literal in four places.
 */
const MS_PER_SEC = 1000;

/**
 * In-process token buckets, one per caller and scope.
 *
 * In-process is the right scope today: the API runs as a single container
 * (the sync lock's boot sweep already relies on that, and says so), so a
 * shared store would add a network hop and a dependency to a decision that
 * has to be made before anything else on the request path. Should the
 * process ever be scaled out, this class is the one place that changes — the
 * guard above it never touches the map.
 *
 * Memory is bounded two ways: a bucket that has refilled to capacity carries
 * no information and is swept, and past {@link RateLimitConfig.maxKeys} the
 * least recently charged bucket is dropped. Both matter because an anonymous
 * caller is keyed by address, and a map keyed by attacker-chosen strings with
 * no ceiling is itself a way to exhaust the process.
 */
@Injectable()
export class RateLimitStore {
  private readonly logger = new Logger(RateLimitStore.name);

  /**
   * Buckets by key. A `Map` rather than an object because insertion order is
   * what the eviction below walks, and because the keys embed caller-
   * controlled strings that must never reach an object's prototype.
   */
  private readonly buckets = new Map<string, RateLimitBucket>();

  private lastSweptAt = 0;

  public constructor(private readonly config: RateLimitConfig) {}

  /**
   * Reports how many buckets are currently tracked, for tests and for
   * anything that wants to observe the map's size.
   *
   * @returns The number of live buckets.
   */
  public get size(): number {
    return this.buckets.size;
  }

  /**
   * Charges one request against a bucket and reports whether it may proceed.
   *
   * The bucket is refilled from elapsed time on the way in, so an idle caller
   * pays nothing to be forgiven and there is no timer per request. A refused
   * request consumes no token — it only moves the bucket's stamp — so a
   * caller hammering a closed door does not push their own recovery further
   * away.
   *
   * @param key - Bucket identity: the caller and the scope being charged.
   * @param rule - The refill policy to apply.
   * @returns What to answer, and what to put in the response headers.
   */
  public consume(key: string, rule: RateLimitRule): RateLimitDecision {
    const now = Date.now();

    this.sweep(now);

    const tokens = this.refill(key, rule, now);

    if (tokens < 1) {
      this.store(key, tokens, rule, now);

      return {
        allowed: false,
        limit: rule.burst,
        remaining: 0,
        retryAfterMs: this.waitFor(tokens, rule),
      };
    }

    const left = tokens - 1;

    this.store(key, left, rule, now);

    return {
      allowed: true,
      limit: rule.burst,
      remaining: Math.floor(left),
      retryAfterMs: this.waitFor(left, rule),
    };
  }

  /**
   * Drops every bucket, so one test cannot leak state into the next.
   */
  public reset(): void {
    this.buckets.clear();
    this.lastSweptAt = 0;
  }

  /**
   * Computes a bucket's token count as of now, treating a caller not seen
   * before as holding a full bucket.
   *
   * @param key - The bucket to read.
   * @param rule - The refill policy to apply.
   * @param now - Current epoch milliseconds.
   * @returns The available tokens, fractional and capped at the burst.
   */
  private refill(key: string, rule: RateLimitRule, now: number): number {
    const bucket = this.buckets.get(key);

    if (!bucket) {
      return rule.burst;
    }

    const elapsedMs = Math.max(0, now - bucket.updatedAt);
    const refilled = elapsedMs * rule.ratePerSec / MS_PER_SEC;

    return Math.min(rule.burst, bucket.tokens + refilled);
  }

  /**
   * Writes a bucket back, re-inserting it so the map's iteration order stays
   * "least recently charged first" for the eviction below.
   *
   * @param key - The bucket to write.
   * @param tokens - Tokens remaining as of `now`.
   * @param rule - The rule this bucket was charged against, used to work out
   *   when it will hold its full burst again.
   * @param now - Current epoch milliseconds.
   */
  private store(
    key: string,
    tokens: number,
    rule: RateLimitRule,
    now: number,
  ): void {
    const missing = Math.max(0, rule.burst - tokens);
    const fullAt = now + Math.ceil(missing * MS_PER_SEC / rule.ratePerSec);

    this.buckets.delete(key);
    this.buckets.set(key, { tokens, updatedAt: now, fullAt });

    this.evictOldest();
  }

  /**
   * Milliseconds until the bucket holds a whole token again.
   *
   * Reported even on an allowed request: a caller that has just spent its
   * last token learns when the next one lands instead of finding out by
   * being refused.
   *
   * @param tokens - Tokens left after the charge.
   * @param rule - The refill policy in force.
   * @returns The wait in milliseconds, zero when a token is already there.
   */
  private waitFor(tokens: number, rule: RateLimitRule): number {
    if (tokens >= 1) {
      return 0;
    }

    return Math.ceil((1 - tokens) * MS_PER_SEC / rule.ratePerSec);
  }

  /**
   * Removes buckets that have refilled to capacity — a full bucket answers
   * exactly as a missing one does, so keeping it only costs memory.
   *
   * Runs at most once per configured interval and only while requests are
   * arriving, which is the only time the map grows.
   *
   * @param now - Current epoch milliseconds.
   */
  private sweep(now: number): void {
    if (now - this.lastSweptAt < this.config.sweepIntervalMs) {
      return;
    }

    this.lastSweptAt = now;

    this.buckets.forEach((bucket, key) => {
      if (bucket.fullAt <= now) {
        this.buckets.delete(key);
      }
    });
  }

  /**
   * Enforces the hard bucket cap by dropping the least recently charged
   * entry, and says so: reaching this line means either far more callers than
   * this deployment has or traffic from rotating addresses, and both are
   * worth seeing in the log.
   */
  private evictOldest(): void {
    if (this.buckets.size <= this.config.maxKeys) {
      return;
    }

    const oldest = this.buckets.keys().next();

    if (oldest.done) {
      return;
    }

    this.buckets.delete(oldest.value);

    this.logger.warn(
      'Rate-limit bucket cap of %d reached, evicted the oldest entry',
      this.config.maxKeys,
    );
  }
}
