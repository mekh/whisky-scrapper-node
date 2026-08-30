import { Module } from '@nestjs/common';
import {
  ValkeyModule as ValkeyBaseModule,
  ValkeyOptions,
} from '@toxicoder/nestjs-valkey';

import { ConfigModule, ValkeyConfig } from '~config';

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
  exports: [
    valkey,
  ],
})
export class ValkeyModule {}
