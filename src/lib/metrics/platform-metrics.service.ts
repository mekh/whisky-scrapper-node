import { Injectable } from '@nestjs/common';
import { Counter, Gauge } from '@prometheus-io/client';

import {
  METRIC_AUTH_LOGIN_ATTEMPTS,
  METRIC_AUTH_THROTTLE_PENALTIES,
  METRIC_CURRENCY_LAST_EFFECTIVE,
  METRIC_CURRENCY_SYNCS,
  METRIC_DB_POOL_CONNECTIONS,
  METRIC_PUSH_DIGESTS,
  METRIC_PUSH_NOTIFICATIONS,
  METRIC_RATE_LIMIT_DECISIONS,
  METRIC_RATE_LIMIT_FAILURES,
} from '~constants';

import { MetricsService } from './metrics.service';

/**
 * Milliseconds in a second, for the rate-freshness gauge.
 */
const MS_PER_SEC = 1000;

/**
 * The cross-cutting counters: the limiter, the login ladder, the pool, push
 * and the currency sync.
 *
 * They sit together because each is two or three metrics that would not
 * justify a file, and because they share one property — each makes visible a
 * state the application already models and nothing outside the process could
 * see. The fail-open counter is the clearest: when the limiter's store cannot
 * answer, requests are let through and the failure is logged at most once a
 * minute, so an API with no effective rate limit looks exactly like one whose
 * limits work.
 */
@Injectable()
export class PlatformMetricsService {
  private readonly rateLimitDecisions: Counter<string>;

  private readonly rateLimitFailures: Counter<string>;

  private readonly loginAttempts: Counter<string>;

  private readonly throttlePenalties: Counter<string>;

  private readonly poolConnections: Gauge<string>;

  private readonly pushNotifications: Counter<string>;

  private readonly pushDigests: Counter<string>;

  private readonly currencySyncs: Counter<string>;

  private readonly currencyFreshness: Gauge<string>;

  public constructor(private readonly metrics: MetricsService) {
    this.rateLimitDecisions = this.metrics.counter({
      name: METRIC_RATE_LIMIT_DECISIONS,
      help: 'Rate-limit charges, by bucket and whether they were allowed.',
      labelNames: [
        'bucket',
        'outcome',
      ],
    });

    this.rateLimitFailures = this.metrics.counter({
      name: METRIC_RATE_LIMIT_FAILURES,
      help: "Requests let through uncounted because the limiter's store "
        + 'could not answer. Every one of these is an unlimited request.',
    });

    this.loginAttempts = this.metrics.counter({
      name: METRIC_AUTH_LOGIN_ATTEMPTS,
      help: 'Login attempts, by outcome: success, failed or throttled.',
      labelNames: [
        'outcome',
      ],
    });

    this.throttlePenalties = this.metrics.counter({
      name: METRIC_AUTH_THROTTLE_PENALTIES,
      help: 'Login penalties imposed, by which rung of the ladder.',
      labelNames: [
        'stage',
      ],
    });

    this.poolConnections = this.metrics.gauge({
      name: METRIC_DB_POOL_CONNECTIONS,
      help: 'Database pool sockets of this replica, by state. `waiting` '
        + 'above zero is the acquire timeout about to start failing.',
      labelNames: [
        'state',
      ],
    });

    this.pushNotifications = this.metrics.counter({
      name: METRIC_PUSH_NOTIFICATIONS,
      help: 'Web-push sends, by outcome: sent, gone, failed, too-large or '
        + 'throttled.',
      labelNames: [
        'outcome',
      ],
    });

    this.pushDigests = this.metrics.counter({
      name: METRIC_PUSH_DIGESTS,
      help: 'Price-drop digests dispatched, by outcome.',
      labelNames: [
        'outcome',
      ],
    });

    this.currencySyncs = this.metrics.counter({
      name: METRIC_CURRENCY_SYNCS,
      help: 'Exchange-rate sync runs, by outcome.',
      labelNames: [
        'outcome',
      ],
    });

    this.currencyFreshness = this.metrics.gauge({
      name: METRIC_CURRENCY_LAST_EFFECTIVE,
      help: 'The newest stored rate per currency, in seconds since the '
        + 'epoch. The source publishes every calendar day, so a gap of more '
        + 'than a couple of days cannot be a weekend.',
      labelNames: [
        'code',
      ],
    });
  }

  /**
   * Records one rate-limit charge.
   *
   * @param bucket - `global` or the profile name.
   * @param allowed - Whether the request was let through.
   */
  public rateLimited(bucket: string, allowed: boolean): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.rateLimitDecisions.inc({
      bucket,
      outcome: allowed ? 'allowed' : 'refused',
    });
  }

  /**
   * Records a request the limiter could not charge and therefore let through.
   */
  public rateLimitFailedOpen(): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.rateLimitFailures.inc();
  }

  /**
   * Records one login attempt's outcome.
   *
   * @param outcome - success, failed or throttled.
   */
  public login(outcome: string): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.loginAttempts.inc({ outcome });
  }

  /**
   * Records a penalty the login ladder imposed.
   *
   * @param stage - Which rung, as its index.
   */
  public loginPenalty(stage: number): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.throttlePenalties.inc({ stage: String(stage) });
  }

  /**
   * Publishes this replica's pool occupancy.
   *
   * @param total - Sockets the pool holds.
   * @param idle - Of those, how many are free.
   * @param waiting - Callers queued for one.
   */
  public pool(total: number, idle: number, waiting: number): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.poolConnections.set({ state: 'total' }, total);
    this.poolConnections.set({ state: 'idle' }, idle);
    this.poolConnections.set({ state: 'waiting' }, waiting);
  }

  /**
   * Records one web-push send.
   *
   * @param outcome - The outcome the push library reported.
   */
  public pushSent(outcome: string): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.pushNotifications.inc({ outcome });
  }

  /**
   * Records one digest dispatch.
   *
   * @param outcome - sent, empty or failed.
   */
  public pushDigest(outcome: string): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.pushDigests.inc({ outcome });
  }

  /**
   * Records one exchange-rate sync run.
   *
   * @param outcome - success or failed.
   */
  public currencySync(outcome: string): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.currencySyncs.inc({ outcome });
  }

  /**
   * Publishes how fresh a currency's stored rates are.
   *
   * @param code - The ISO code.
   * @param effectiveOn - The newest day stored for it.
   */
  public currencyFresh(code: string, effectiveOn: Date): void {
    if (!this.metrics.enabled) {
      return;
    }

    this.currencyFreshness.set({ code }, effectiveOn.getTime() / MS_PER_SEC);
  }
}
