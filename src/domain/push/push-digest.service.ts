import { Injectable, Logger } from '@nestjs/common';

import { PushConfig } from '~config';
import { PUSH_MAX_PREVIOUS_GAP_DAYS } from '~constants';
import { CorePriceSnapshotService } from '~core/price-snapshot';
import { CorePushService } from '~core/push';
import { WebPushService } from '~lib/web-push';
import {
  ID,
  PushDeliveryStats,
  PushDispatchInput,
  PushDispatchReport,
  PushUserTarget,
} from '~types';
import { ConcurrencyPool, PushDigestUtils } from '~utils';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The post-sync notification pass: claims the capture day's not-yet-announced
 * price drops on favorited bottlings and sends each affected user one digest
 * push.
 *
 * Two invariants the sync hook relies on:
 *
 * - Nothing here is wrapped in `@Transactional()` — the orchestrator calls
 *   this from background runs, where the ALS context would leak (the same
 *   reason the sync lock path is unwrapped).
 * - The digest's discount is measured against the offer's previous recorded
 *   price, deliberately unlike the `/report/drops` page, whose reference is
 *   the window maximum. The push answers "cheaper than yesterday?", the page
 *   answers "how good is this price?" — do not "fix" one to match the other.
 */
@Injectable()
export class PushDigestService {
  /**
   * Today as a UTC calendar day — the same convention `capturedOn` is written
   * with by the persist pipeline.
   *
   * @returns The day as `YYYY-MM-DD`.
   */
  private static today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Shifts a calendar day by a number of days, in UTC.
   *
   * @param day - The day (`YYYY-MM-DD`) to shift.
   * @param days - How many days to add; negative shifts back.
   * @returns The shifted day as `YYYY-MM-DD`.
   */
  private static shiftDay(day: string, days: number): string {
    const at = new Date(`${day}T00:00:00Z`).getTime();

    return new Date(at + days * MS_PER_DAY).toISOString().slice(0, 10);
  }

  /**
   * A report with every counter at zero.
   *
   * @param capturedOn - The day the (empty) pass covered.
   * @returns The zeroed report.
   */
  private static emptyReport(capturedOn: string): PushDispatchReport {
    return {
      capturedOn,
      users: 0,
      items: 0,
      sent: 0,
      gone: 0,
      failed: 0,
    };
  }

  private readonly logger = new Logger(PushDigestService.name);

  public constructor(
    private readonly core: CorePushService,
    private readonly snapshots: CorePriceSnapshotService,
    private readonly webPush: WebPushService,
    private readonly config: PushConfig,
  ) {}

  /**
   * Runs one dispatch pass: claim the day's drops, send one digest per user,
   * prune dead subscriptions and expired dedup rows. Idempotent — a repeat
   * call for the same day claims nothing and sends nothing.
   *
   * @param input - Optional override of the capture day; defaults to the
   *   latest day present in `price_snapshot`.
   * @returns What the pass did.
   */
  public async dispatch(
    input?: PushDispatchInput,
  ): Promise<PushDispatchReport> {
    if (!this.webPush.enabled) {
      return PushDigestService.emptyReport(
        input?.capturedOn ?? PushDigestService.today(),
      );
    }

    const hasSubscriptions = await this.core.hasAnySubscription();

    if (!hasSubscriptions) {
      return PushDigestService.emptyReport(
        input?.capturedOn ?? PushDigestService.today(),
      );
    }

    const capturedOn = await this.resolveDay(input);
    const drops = await this.core.claimDrops(
      capturedOn,
      PUSH_MAX_PREVIOUS_GAP_DAYS,
    );

    const byUser = PushDigestUtils.byUser(drops);
    const payloads = new Map<ID, string>();

    byUser.forEach((rows, userId) => {
      const items = PushDigestUtils.bestPerProduct(rows);

      payloads.set(userId, JSON.stringify(PushDigestUtils.payload(items)));
    });

    const targets = await this.core.findTargetsByUserIds([...byUser.keys()]);

    const stats = await this.broadcast(
      targets,
      (target) => payloads.get(target.userId) ?? '',
    );

    await this.core.pruneDigestLog(
      PushDigestService.shiftDay(capturedOn, -this.config.logRetentionDays),
    );

    const report: PushDispatchReport = {
      capturedOn,
      users: byUser.size,
      items: drops.length,
      ...stats,
    };

    this.logger.log(
      'Push digest %s: %d drop(s) for %d user(s), sent %d, gone %d, failed %d',
      report.capturedOn,
      report.items,
      report.users,
      report.sent,
      report.gone,
      report.failed,
    );

    return report;
  }

  /**
   * The sync hook: runs a dispatch and swallows every failure — a sync must
   * never fail or be delayed by notifications.
   *
   * @returns Resolves once the pass ended, however it ended.
   */
  public async dispatchAfterSync(): Promise<void> {
    try {
      await this.dispatch();
    } catch (error) {
      this.logger.error('Post-sync push dispatch failed: %o', error);
    }
  }

  /**
   * Sends one payload per target, capped by the configured concurrency, then
   * drops the subscriptions that came back dead and stamps the ones that
   * accepted.
   *
   * @param targets - Subscriptions to send to.
   * @param payloadOf - Resolves the payload for one target.
   * @returns How many sends succeeded, found a dead endpoint, or failed.
   */
  public async broadcast(
    targets: PushUserTarget[],
    payloadOf: (target: PushUserTarget) => string,
  ): Promise<PushDeliveryStats> {
    const sentEndpoints: string[] = [];
    const goneEndpoints: string[] = [];

    let failed = 0;

    await ConcurrencyPool.run(
      targets,
      this.config.concurrency,
      async (target) => {
        const outcome = await this.webPush.send(target, payloadOf(target));

        if (outcome === 'sent') {
          sentEndpoints.push(target.endpoint);
        } else if (outcome === 'gone') {
          goneEndpoints.push(target.endpoint);
        } else {
          failed += 1;
        }
      },
    );

    await this.core.dropDeadEndpoints(goneEndpoints);
    await this.core.touchSuccess(sentEndpoints);

    return {
      sent: sentEndpoints.length,
      gone: goneEndpoints.length,
      failed,
    };
  }

  /**
   * Resolves the capture day a dispatch covers. Read from the data, not the
   * clock, so a sync run that crosses UTC midnight still dispatches the day
   * it actually wrote.
   *
   * @param input - Optional explicit day.
   * @returns The day as `YYYY-MM-DD`.
   */
  private async resolveDay(input?: PushDispatchInput): Promise<string> {
    if (input?.capturedOn) {
      return input.capturedOn;
    }

    const latest = await this.snapshots.latestDate();

    return latest ?? PushDigestService.today();
  }
}
