import { Module } from '@nestjs/common';
import {
  ValkeyModule as ValkeyBaseModule,
  ValkeyOptions,
} from '@toxicoder/nestjs-valkey';

import { CacheConfig, ConfigModule } from '~config';

import { VersionedCacheService } from './versioned-cache.service';

/**
 * Builds the cache client's options from configuration.
 *
 * Every wait is bounded, for the same reason the session client's are: an
 * unbounded command on a black-holed connection is how a dependency's bad
 * minute becomes the application's outage. The offline queue stays off so a
 * command issued while disconnected fails at once instead of piling up —
 * which for a cache is exactly right, since a failure here is a miss.
 *
 * @param config - The resolved cache settings.
 * @returns Options for the underlying client.
 */
function buildOptions(config: CacheConfig): ValkeyOptions {
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
    enableOfflineQueue: false,
  };
}

/**
 * The cache's own Valkey connection — deliberately a **second** one.
 *
 * Two modules, two instances: Nest resolves a provider from the scope of the
 * module that imports it, so `CacheModule` gets this client and everything
 * importing `~lib/valkey` gets the session one. That is the ordinary way to
 * run two connections and it needs no defending.
 *
 * The reason there are two is that the cache and the auth sessions want
 * incompatible things from a full instance. A cache should shed its oldest
 * entries; a session store must never lose a key, because a missing session
 * reads as a revoked one and signs the user out of every device.
 * `maxmemory-policy` is per instance, so no single policy serves both, and
 * separating them is the only way to give the cache an eviction policy at
 * all.
 *
 * `~lib/valkey`'s warning against a second `forRootAsync` is about a
 * different mistake — registering the *same* logical store twice, which
 * splits one connection pool and one body of state in half. Two stores are
 * not that case.
 *
 * What the two registrations do share is the DI token, since both provide
 * the class `ValkeyService`; the module scope, not the token, is what says
 * which connection a service gets. Nothing today can be confused by that,
 * because this registration is not exported — `CacheModule` hands out
 * `VersionedCacheService` and nothing else. Keep it that way and the
 * question never arises.
 *
 * Sharing remains the default — every `CACHE_VALKEY_*` setting falls back to
 * its `VALKEY_*` equivalent — so a development machine runs one instance and
 * production sets one variable to split them.
 */
const cacheValkey = ValkeyBaseModule.forRootAsync({
  imports: [
    ConfigModule,
  ],
  inject: [
    CacheConfig,
  ],
  useFactory: buildOptions,
});

@Module({
  imports: [
    /**
     * `ConfigModule` is imported here as well as inside the registration
     * above: that one only reaches the options factory, while this one is
     * what lets the service itself be given its `CacheConfig`.
     */
    ConfigModule,
    cacheValkey,
  ],
  providers: [
    VersionedCacheService,
  ],
  exports: [
    VersionedCacheService,
  ],
})
export class CacheModule {}
