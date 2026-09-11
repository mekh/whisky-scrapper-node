import { Injectable } from '@nestjs/common';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Min,
} from 'class-validator';

import type { CacheSettings } from '~types';

import { BaseConfig } from '../base.config';

/**
 * A day. Generations bump at least once a day (the sync cron writes every
 * store) and the `new`/`drops` keys rotate at UTC midnight anyway, so an
 * entry older than this is garbage by construction rather than by policy.
 */
const DEFAULT_TTL_SEC = 86400;

/**
 * A quarter of a second. A hit that takes longer than this has already lost
 * to the query it replaces on most reports.
 */
const DEFAULT_READ_TIMEOUT_MS = 250;

/**
 * Eight mebibytes. The largest real entry — the whole unfiltered catalogue —
 * is around a megabyte compressed, so this refuses only something that has
 * gone wrong.
 */
const DEFAULT_MAX_ENTRY_BYTES = 8 * 1024 * 1024;

const DEFAULT_HOST = '127.0.0.1';

const DEFAULT_PORT = 6379;

const DEFAULT_COMMAND_TIMEOUT_MS = 2000;

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

const DEFAULT_KEEP_ALIVE_MS = 10000;

const DEFAULT_MAX_RETRIES_PER_REQUEST = 2;

/**
 * Settings for the catalogue cache and for the Valkey instance it lives on.
 *
 * **Every connection field is read twice**: its own `CACHE_VALKEY_*` name
 * first, then the `VALKEY_*` name the session client uses. That is what
 * makes the split a deployment decision rather than a code one — development
 * sets nothing and shares one instance, production sets `CACHE_VALKEY_HOST`
 * and gets an instance it can safely run with `allkeys-lru`, which the
 * session instance must never use.
 *
 * The fallback is read with `nonEmpty` rather than `??` on `asString`, and
 * that is not a detail: compose forwards an omitted host variable as an
 * *empty string*, so `asString('CACHE_VALKEY_HOST') ?? …` would hand the
 * empty string on as if it were configured and the fallback would be
 * unreachable in production — the mistake that once disabled push.
 */
@Injectable()
export class CacheConfig extends BaseConfig implements CacheSettings {
  @IsBoolean()
  public readonly enabled = this.asBoolean('CACHE_ENABLED') ?? true;

  @IsBoolean()
  public readonly bootBump = this.asBoolean('CACHE_BOOT_BUMP') ?? true;

  @IsInt()
  @IsPositive()
  public readonly ttlSec = this.asNumber('CACHE_TTL_SEC') ?? DEFAULT_TTL_SEC;

  @IsInt()
  @IsPositive()
  public readonly readTimeoutMs = this.asNumber('CACHE_READ_TIMEOUT_MS')
    ?? DEFAULT_READ_TIMEOUT_MS;

  @IsInt()
  @IsPositive()
  public readonly maxEntryBytes = this.asNumber('CACHE_MAX_ENTRY_BYTES')
    ?? DEFAULT_MAX_ENTRY_BYTES;

  @IsString()
  public readonly host = this.shared('HOST') ?? DEFAULT_HOST;

  @IsInt()
  @IsPositive()
  public readonly port = this.sharedNumber('PORT') ?? DEFAULT_PORT;

  @IsInt()
  @Min(0)
  @IsOptional()
  public readonly db = this.sharedNumber('DB');

  @IsString()
  @IsOptional()
  public readonly password = this.shared('PASSWORD');

  @IsString()
  public readonly keyPrefix = this.shared('PREFIX') ?? '';

  @IsInt()
  @IsPositive()
  public readonly commandTimeoutMs = this.sharedNumber('COMMAND_TIMEOUT_MS')
    ?? DEFAULT_COMMAND_TIMEOUT_MS;

  @IsInt()
  @IsPositive()
  public readonly connectTimeoutMs = this.sharedNumber('CONNECT_TIMEOUT_MS')
    ?? DEFAULT_CONNECT_TIMEOUT_MS;

  @IsInt()
  @Min(0)
  public readonly keepAliveMs = this.sharedNumber('KEEP_ALIVE_MS')
    ?? DEFAULT_KEEP_ALIVE_MS;

  @IsInt()
  @Min(0)
  public readonly maxRetriesPerRequest =
    this.sharedNumber('MAX_RETRIES_PER_REQUEST')
      ?? DEFAULT_MAX_RETRIES_PER_REQUEST;

  /**
   * Reads a connection setting, preferring the cache's own variable and
   * falling back to the session client's.
   *
   * @param suffix - The part of the name after the prefix, e.g. `HOST`.
   * @returns The configured value, or undefined when neither is set.
   */
  private shared(suffix: string): string | undefined {
    return this.nonEmpty(`CACHE_VALKEY_${suffix}`)
      ?? this.nonEmpty(`VALKEY_${suffix}`);
  }

  /**
   * The numeric counterpart of {@link shared}.
   *
   * @param suffix - The part of the name after the prefix, e.g. `PORT`.
   * @returns The configured value, or undefined when neither is set.
   */
  private sharedNumber(suffix: string): number | undefined {
    return this.asNumber(`CACHE_VALKEY_${suffix}`)
      ?? this.asNumber(`VALKEY_${suffix}`);
  }
}
