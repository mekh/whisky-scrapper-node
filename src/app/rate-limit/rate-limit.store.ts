import { Injectable, Logger } from '@nestjs/common';

import { RateLimitConfig } from '~config';
import {
  RATE_LIMIT_FAILURE_LOG_WINDOW_MS,
  RATE_LIMIT_KEY_ROOT,
} from '~constants';
import { ValkeyScript, ValkeyService } from '~lib/valkey';
import type { RateLimitCharge, RateLimitDecision } from '~types';
import { DeadlineUtils, ErrorUtils } from '~utils';

import {
  RATE_LIMIT_CONSUME_COMMAND,
  RATE_LIMIT_CONSUME_SCRIPT,
  RATE_LIMIT_REPLY_FIELDS,
} from './rate-limit-consume.script';

/**
 * Token buckets held in Valkey, one per caller and scope.
 *
 * Shared rather than in-process because the API now runs as several
 * instances: a bucket per instance would mean N independent budgets and an
 * effective limit N times what is configured. One script call charges every
 * bucket a request owes, so the move costs one round trip rather than one
 * per bucket.
 *
 * Memory is bounded by the buckets' own lifetime — a bucket expires when it
 * would next hold its full burst, which for the global rule is under four
 * seconds — so nothing here has to cap or sweep them.
 */
@Injectable()
export class RateLimitStore {
  /**
   * Reads a script reply, refusing anything that is not the expected run of
   * numbers rather than deriving a limit from it.
   *
   * @param reply - Whatever the driver handed back.
   * @param expected - How many buckets were charged, at most.
   * @returns The numbers, or null when the reply was not usable.
   */
  private static numbers(reply: unknown, expected: number): number[] | null {
    if (!Array.isArray(reply)) {
      return null;
    }

    const usable = reply.length % RATE_LIMIT_REPLY_FIELDS === 0
      && reply.length <= expected * RATE_LIMIT_REPLY_FIELDS
      && reply.every((value) => typeof value === 'number');

    return usable ? reply as number[] : null;
  }

  /**
   * Turns the script's flat run of numbers into one decision per bucket it
   * charged.
   *
   * @param reply - The script's numbers.
   * @param charges - The buckets, in the order they were sent.
   * @returns The decisions, shorter than `charges` when one refused.
   */
  private static decisions(
    reply: number[],
    charges: RateLimitCharge[],
  ): RateLimitDecision[] {
    const charged = reply.length / RATE_LIMIT_REPLY_FIELDS;

    return charges.slice(0, charged).map((charge, index) => {
      const at = index * RATE_LIMIT_REPLY_FIELDS;

      return {
        allowed: reply[at] === 1,
        limit: charge.rule.burst,
        remaining: reply[at + 1] ?? 0,
        retryAfterMs: reply[at + 2] ?? 0,
      };
    });
  }

  private readonly logger = new Logger(RateLimitStore.name);

  private readonly script: ValkeyScript;

  private suppressed = 0;

  private lastFailureLogAt: number | null = null;

  public constructor(
    private readonly config: RateLimitConfig,
    valkey: ValkeyService,
  ) {
    this.script = new ValkeyScript(
      valkey.getClient(),
      RATE_LIMIT_CONSUME_COMMAND,
      RATE_LIMIT_CONSUME_SCRIPT,
    );
  }

  /**
   * Charges a request's buckets in order and reports what each answered.
   *
   * The chain stops at the first bucket that refuses, so a request turned
   * away by the global rule spends nothing from the route's own allowance.
   *
   * @param charges - The buckets to charge, in the order they apply.
   * @returns One decision per bucket charged — fewer than were asked for
   *   when one refused, and none at all when the store could not answer.
   */
  public async consume(
    charges: RateLimitCharge[],
  ): Promise<RateLimitDecision[]> {
    if (charges.length === 0) {
      return [];
    }

    const reply = await this.run(charges);
    const numbers = RateLimitStore.numbers(reply, charges.length);

    if (!numbers) {
      return [];
    }

    return RateLimitStore.decisions(numbers, charges);
  }

  /**
   * Runs the charge script, bounded and failing open.
   *
   * Fail-open is the deliberate choice, and the same one the login ladder
   * makes: a store that cannot answer must not become an API that refuses
   * every request, and the edge's own `limit_req` still stands.
   *
   * @param charges - The buckets to charge.
   * @returns The script's reply, or null when it failed or timed out.
   */
  private async run(charges: RateLimitCharge[]): Promise<unknown> {
    const keys = charges.map((charge) =>
      `${RATE_LIMIT_KEY_ROOT}:${charge.key}`
    );

    const args = charges.flatMap((charge) => [
      charge.rule.ratePerSec,
      charge.rule.burst,
    ]);

    try {
      return await DeadlineUtils.bounded(
        this.script.run(keys, args),
        this.config.timeoutMs,
      );
    } catch (error) {
      this.recordFailure(ErrorUtils.text(error));

      return null;
    }
  }

  /**
   * Reports a failure, at most once per window and saying how many it stands
   * for.
   *
   * The first failure is logged at once — an outage shorter than the window
   * would otherwise go unrecorded — and the rest are counted into the next
   * such line.
   *
   * @param reason - What this failure said.
   */
  private recordFailure(reason: string): void {
    const now = Date.now();
    const loggedAt = this.lastFailureLogAt;
    const quiet = loggedAt !== null
      && now - loggedAt < RATE_LIMIT_FAILURE_LOG_WINDOW_MS;

    if (quiet) {
      this.suppressed += 1;

      return;
    }

    this.logger.warn(
      'Rate limiter failed, allowing the request (%d more since the last'
        + ' such line): %s',
      this.suppressed,
      reason,
    );

    this.suppressed = 0;
    this.lastFailureLogAt = now;
  }
}
