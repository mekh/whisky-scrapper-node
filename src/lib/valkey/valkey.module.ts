import { Module } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import {
  ValkeyModule as ValkeyBaseModule,
  ValkeyOptions,
  ValkeyService,
} from '@toxicoder/nestjs-valkey';

import { ConfigModule, ValkeyConfig } from '~config';

import { ValkeyPubSubService } from './valkey-pubsub.service';

/**
 * Builds the client options from configuration.
 *
 * Everything beyond the address exists to bound failure. The library's own
 * factory sets none of it, so a stalled or black-holed connection blocks its
 * callers indefinitely — and since every authenticated request checks its
 * session here, "its callers" means the entire API.
 *
 * @param config - The resolved Valkey settings.
 * @returns Options for the underlying client.
 */
function buildOptions(config: ValkeyConfig): ValkeyOptions {
  return {
    host: config.host,
    port: config.port,
    db: config.db,
    password: config.password,
    keyPrefix: config.keyPrefix,
    commandTimeout: config.commandTimeoutMs,
    connectTimeout: config.connectTimeoutMs,
    keepAlive: config.keepAliveMs,
    maxRetriesPerRequest: config.maxRetriesPerRequest,
    enableOfflineQueue: config.offlineQueue,
  };
}

/**
 * The one Valkey connection this process owns.
 *
 * Built once, at module-evaluation time, and both imported and re-exported as
 * the same object: a second `forRootAsync` call would be a second dynamic
 * module and therefore a second client, which is how a "shared" cache quietly
 * becomes two.
 */
const valkey = ValkeyBaseModule.forRootAsync({
  imports: [
    ConfigModule,
  ],
  inject: [
    ValkeyConfig,
  ],
  useFactory: buildOptions,
});

@Module({
  imports: [
    valkey,
  ],
  providers: [
    ValkeyPubSubService,
  ],
  exports: [
    valkey,
    ValkeyPubSubService,
  ],
})
export class ValkeyModule implements OnModuleDestroy {
  public constructor(private readonly valkey: ValkeyService) {}

  /**
   * Closes the connection when the application shuts down.
   *
   * **The wrapper package does not do this**, and an open client keeps the
   * event loop alive: a standalone script finishes its work and then hangs
   * forever, and a container answers `SIGTERM` by lingering until its grace
   * period runs out and it is killed. `ValkeyPubSubService` already closes
   * the connection it duplicates for the same reason; this is the primary
   * one, which nothing was closing.
   */
  public onModuleDestroy(): void {
    this.valkey.disconnect();
  }
}
