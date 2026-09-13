import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';

import {
  INSTANCE_HEARTBEAT_INTERVAL_MS,
  INSTANCE_HEARTBEAT_TTL_SEC,
  INSTANCE_KEY_ROOT,
} from '~constants';
import { ValkeyClient, ValkeyCluster, ValkeyService } from '~lib/valkey';
import { ErrorUtils } from '~utils';

/**
 * How much of the host name an instance id may carry, leaving room for the
 * process id and the random suffix inside the column's 64 characters.
 */
const HOST_MAX_LENGTH = 40;

/**
 * Who this process is, and which other processes are still up.
 *
 * It exists for the sync orphan sweep: closing an open `sync_log` row
 * releases the store's concurrency lock, so a restarting instance must be
 * able to tell its sibling's live run from a dead process's leftover. The
 * heartbeat answers that, and doubles as the liveness signal monitoring can
 * read — `valkey-cli --scan --pattern 'instance:*'` lists what is up.
 */
@Injectable()
export class InstanceService
  implements OnApplicationBootstrap, OnModuleDestroy {
  /**
   * Names this process.
   *
   * The host and process id are what an operator needs to find the container;
   * the random suffix is what makes the name unique in time, so a restart
   * that happens to reuse a process id cannot read its own predecessor's
   * leftover key and conclude that a dead run is alive.
   *
   * @returns The instance id.
   */
  private static identify(): string {
    const host = hostname().slice(0, HOST_MAX_LENGTH);

    return `${host}:${process.pid}:${randomBytes(3).toString('hex')}`;
  }

  public readonly id = InstanceService.identify();

  private readonly logger = new Logger(InstanceService.name);

  private readonly storage: ValkeyClient | ValkeyCluster;

  private timer: NodeJS.Timeout | null = null;

  public constructor(valkey: ValkeyService) {
    this.storage = valkey.getClient();
  }

  /**
   * Announces this process and starts refreshing its liveness key.
   *
   * @returns Resolves once the first beat is written.
   */
  public async onApplicationBootstrap(): Promise<void> {
    await this.beat();

    this.timer = setInterval(() => {
      void this.beat();
    }, INSTANCE_HEARTBEAT_INTERVAL_MS);

    /**
     * Unreferenced so a script carrying this module exits when its work is
     * done rather than being held open by the heartbeat.
     */
    this.timer.unref();

    this.logger.log(
      'Instance %s is live, heartbeat every %d s',
      this.id,
      INSTANCE_HEARTBEAT_INTERVAL_MS / 1000,
    );
  }

  /**
   * Stops the heartbeat and drops the key, so a clean shutdown is noticed at
   * once instead of after the key's time to live.
   *
   * @returns Resolves once the key is gone.
   */
  public async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);

      this.timer = null;
    }

    await this.attempt('release', () => this.storage.del(this.key(this.id)));
  }

  /**
   * Reports which of the given instances are still up.
   *
   * @param ids - The instances to ask about.
   * @returns The ids that answered, or null when the question could not be
   *   put at all — which a caller must not read as "none of them".
   */
  public async aliveAmong(ids: string[]): Promise<Set<string> | null> {
    if (ids.length === 0) {
      return new Set();
    }

    const values = await this.attempt(
      'liveness',
      () => this.storage.mget(...ids.map((id) => this.key(id))),
    );

    if (!values) {
      return null;
    }

    return new Set(ids.filter((_id, index) => values[index] !== null));
  }

  /**
   * Writes this process's liveness key with a fresh expiry.
   *
   * @returns Resolves once written, or once the failure is logged.
   */
  private async beat(): Promise<void> {
    await this.attempt('heartbeat', () =>
      this.storage.set(
        this.key(this.id),
        new Date().toISOString(),
        'EX',
        INSTANCE_HEARTBEAT_TTL_SEC,
      ));
  }

  /**
   * Runs one command, turning a failure into a warning and a null.
   *
   * @param operation - What to call the command in the log.
   * @param command - The command to run.
   * @returns Its result, or null when it failed.
   */
  private async attempt<T>(
    operation: string,
    command: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await command();
    } catch (error) {
      this.logger.warn(
        'Instance %s failed: %s',
        operation,
        ErrorUtils.text(error),
      );

      return null;
    }
  }

  /**
   * The key one instance's liveness is recorded under.
   *
   * @param id - The instance id.
   * @returns Its key.
   */
  private key(id: string): string {
    return `${INSTANCE_KEY_ROOT}:${id}`;
  }
}
