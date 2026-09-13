import { Injectable, Logger } from '@nestjs/common';

import { CRON_LOCK_KEY_ROOT, CRON_LOCK_TTL_SEC } from '~constants';
import { InstanceService } from '~lib/instance';
import { ValkeyClient, ValkeyCluster, ValkeyService } from '~lib/valkey';
import { ErrorUtils } from '~utils';

/**
 * Elects one instance to run a scheduled tick.
 *
 * Every instance arms the same schedules, so every instance fires. The claim
 * is a single `SET NX EX`: the first to arrive runs the job and the rest
 * stand down. There is no long-lived leader and nothing to renew — the claim
 * expires on its own, and the next tick is a fresh race.
 *
 * The key holds the winner's instance id, which is what makes an operator
 * able to answer "which container ran last night's sync".
 */
@Injectable()
export class CronLockService {
  private readonly logger = new Logger(CronLockService.name);

  private readonly storage: ValkeyClient | ValkeyCluster;

  public constructor(
    valkey: ValkeyService,
    private readonly instances: InstanceService,
  ) {
    this.storage = valkey.getClient();
  }

  /**
   * Claims a job's tick for this instance.
   *
   * A failure to claim at all is answered with **yes**, deliberately: this
   * lock only keeps the fleet tidy, it is not what makes a job safe to run
   * twice — the sync's own `sync_log` lock and the rate sync's upserts are —
   * so a Valkey outage must not be able to stop the schedule altogether.
   *
   * @param job - The job's name, which is also its registry key.
   * @param ttlSec - How long the claim stands.
   * @returns Whether this instance should run the tick.
   */
  public async claim(
    job: string,
    ttlSec: number = CRON_LOCK_TTL_SEC,
  ): Promise<boolean> {
    const key = `${CRON_LOCK_KEY_ROOT}:${job}`;

    try {
      const won = await this.storage.set(
        key,
        this.instances.id,
        'EX',
        ttlSec,
        'NX',
      );

      if (won) {
        return true;
      }

      this.logger.log(
        'Skipping the %s tick: instance %s claimed it',
        job,
        await this.holder(key),
      );

      return false;
    } catch (error) {
      this.logger.warn(
        'Could not claim the %s tick, running it anyway: %s',
        job,
        ErrorUtils.text(error),
      );

      return true;
    }
  }

  /**
   * Reads who holds a claim, for the line that says why this tick was
   * skipped.
   *
   * @param key - The claim's key.
   * @returns The holder's instance id, or a placeholder when it cannot be
   *   read — it expired between the two commands, or the read failed.
   */
  private async holder(key: string): Promise<string> {
    try {
      return await this.storage.get(key) ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
}
