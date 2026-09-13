import { Injectable } from '@nestjs/common';
import { IsBoolean, IsInt, IsPositive } from 'class-validator';

import { RateLimitProfile } from '~enums';
import type { RateLimitRule } from '~types';

import { BaseConfig } from '../base.config';

/**
 * Sustained requests per second one caller may make across the whole API.
 * Low on purpose: this is a private catalogue with a handful of accounts,
 * and every legitimate screen is a handful of reads followed by idleness.
 */
const DEFAULT_RATE_PER_SEC = 3;

/**
 * How many of those requests may arrive at once. A page load fans out —
 * `/meta`, a report, `/preference`, `/collection/ids`, `/quick-filter` — so
 * the burst is what separates "a screen opened" from "a loop is hammering
 * us", which a bare per-second window cannot tell apart.
 */
const DEFAULT_BURST = 10;

const DEFAULT_HEAVY_RATE_PER_SEC = 1;

/**
 * Equivalent to the 60-per-60-seconds budget the retired
 * `UserThrottlerGuard` gave the report and dashboard reads: same sustained
 * rate, same amount spendable at once.
 */
const DEFAULT_HEAVY_BURST = 60;

const DEFAULT_STRICT_RATE_PER_SEC = 1;

const DEFAULT_STRICT_BURST = 3;

const DEFAULT_AUTH_RATE_PER_SEC = 1;

/**
 * Five is the same number of attempts the login ladder allows per run, so
 * the flat ceiling and the ladder refuse at the same point rather than one
 * of them being decorative.
 */
const DEFAULT_AUTH_BURST = 5;

/**
 * How long one charge may take before the request is let through uncounted.
 * Far below the client's own command timeout: a limiter slower than the
 * handler it guards costs more than it saves, and it fails open anyway.
 */
const DEFAULT_TIMEOUT_MS = 250;

/**
 * Per-caller request-rate limits.
 *
 * Two levels: every request pays the global rule below, and a route that
 * carries `@RateLimit(profile)` additionally pays that profile's own bucket.
 * The two are separate buckets, so a tightened route neither spends nor is
 * spent by the rest of the API.
 *
 * The buckets themselves live in Valkey, shared by every instance, and expire
 * as soon as they would hold their full burst again — so there is nothing
 * here to cap or to sweep.
 */
@Injectable()
export class RateLimitConfig extends BaseConfig {
  @IsBoolean()
  public readonly enabled = this.asBoolean('RATE_LIMIT_ENABLED') ?? true;

  @IsInt()
  @IsPositive()
  public readonly ratePerSec = this.asNumber('RATE_LIMIT_RPS')
    ?? DEFAULT_RATE_PER_SEC;

  @IsInt()
  @IsPositive()
  public readonly burst = this.asNumber('RATE_LIMIT_BURST')
    ?? DEFAULT_BURST;

  @IsInt()
  @IsPositive()
  public readonly heavyRatePerSec = this.asNumber('RATE_LIMIT_HEAVY_RPS')
    ?? DEFAULT_HEAVY_RATE_PER_SEC;

  @IsInt()
  @IsPositive()
  public readonly heavyBurst = this.asNumber('RATE_LIMIT_HEAVY_BURST')
    ?? DEFAULT_HEAVY_BURST;

  @IsInt()
  @IsPositive()
  public readonly strictRatePerSec = this.asNumber('RATE_LIMIT_STRICT_RPS')
    ?? DEFAULT_STRICT_RATE_PER_SEC;

  @IsInt()
  @IsPositive()
  public readonly strictBurst = this.asNumber('RATE_LIMIT_STRICT_BURST')
    ?? DEFAULT_STRICT_BURST;

  @IsInt()
  @IsPositive()
  public readonly authRatePerSec = this.asNumber('RATE_LIMIT_AUTH_RPS')
    ?? DEFAULT_AUTH_RATE_PER_SEC;

  @IsInt()
  @IsPositive()
  public readonly authBurst = this.asNumber('RATE_LIMIT_AUTH_BURST')
    ?? DEFAULT_AUTH_BURST;

  @IsInt()
  @IsPositive()
  public readonly timeoutMs = this.asNumber('RATE_LIMIT_TIMEOUT_MS')
    ?? DEFAULT_TIMEOUT_MS;

  /**
   * The rule every request is charged against, whatever route it hits.
   *
   * @returns The global per-caller rule.
   */
  public get globalRule(): RateLimitRule {
    return { ratePerSec: this.ratePerSec, burst: this.burst };
  }

  /**
   * Resolves a route's declared profile to its rule.
   *
   * @param profile - The profile the route opted into.
   * @returns That profile's rule.
   */
  public ruleFor(profile: RateLimitProfile): RateLimitRule {
    switch (profile) {
      case RateLimitProfile.HEAVY:
        return { ratePerSec: this.heavyRatePerSec, burst: this.heavyBurst };
      case RateLimitProfile.AUTH:
        return { ratePerSec: this.authRatePerSec, burst: this.authBurst };
      default:
        return { ratePerSec: this.strictRatePerSec, burst: this.strictBurst };
    }
  }
}
