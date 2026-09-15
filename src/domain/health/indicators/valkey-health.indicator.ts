import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';

import { ValkeyClient, ValkeyCluster, ValkeyService } from '~lib/valkey';
import { DeadlineUtils } from '~utils';

/**
 * Key this indicator reports under, matching the metric label.
 */
const KEY = 'valkey_session';

/**
 * How long the session store may take to answer before it counts as down.
 * The same bound its own commands carry, so the probe agrees with what a
 * request would experience rather than being more forgiving.
 */
const TIMEOUT_MS = 2000;

/**
 * Whether the session store answers.
 *
 * It is a **hard** dependency: the auth guard reads a session before every
 * authenticated request and fails closed, so a store that cannot answer is an
 * API that answers nothing but 401. Down here therefore means down.
 */
@Injectable()
export class ValkeyHealthIndicator {
  private readonly client: ValkeyClient | ValkeyCluster;

  public constructor(
    private readonly health: HealthIndicatorService,
    valkey: ValkeyService,
  ) {
    this.client = valkey.getClient();
  }

  /**
   * Probes the session store.
   *
   * @returns The indicator result, up or down.
   */
  public async check(): Promise<HealthIndicatorResult> {
    const session = this.health.check(KEY);
    const startedAt = Date.now();

    try {
      await DeadlineUtils.bounded(this.client.ping(), TIMEOUT_MS);

      return session.up({ responseTime: Date.now() - startedAt });
    } catch (error: unknown) {
      return session.down({
        responseTime: Date.now() - startedAt,
        reason: error instanceof Error ? error.message : 'unreachable',
      });
    }
  }
}
