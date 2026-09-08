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
 * Most callers tracked at once. Reached only by anonymous traffic, which is
 * keyed by address; past it the least recently charged bucket is dropped, so
 * the map cannot grow without bound on rotating source addresses.
 */
const DEFAULT_MAX_KEYS = 10000;

/**
 * How often idle buckets are swept. The sweep is lazy — it runs on a charge,
 * never on a timer — so it costs nothing while the process is idle, which is
 * also when nothing is being added to sweep.
 */
const DEFAULT_SWEEP_INTERVAL_MS = 60000;

/**
 * Per-caller request-rate limits.
 *
 * Two levels: every request pays the global rule below, and a route that
 * carries `@RateLimit(profile)` additionally pays that profile's own bucket.
 * The two are separate buckets, so a tightened route neither spends nor is
 * spent by the rest of the API.
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
  public readonly maxKeys = this.asNumber('RATE_LIMIT_MAX_KEYS')
    ?? DEFAULT_MAX_KEYS;

  @IsInt()
  @IsPositive()
  public readonly sweepIntervalMs = this.asNumber('RATE_LIMIT_SWEEP_MS')
    ?? DEFAULT_SWEEP_INTERVAL_MS;

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
