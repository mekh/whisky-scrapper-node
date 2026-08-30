import { Injectable } from '@nestjs/common';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Min,
} from 'class-validator';

import type { ValkeySettings } from '~types';

import { BaseConfig } from '../base.config';

/**
 * One session lookup is a single `EXISTS` against a cache on the same host.
 * Two seconds is already an eternity for it, and the only thing a longer wait
 * buys is a longer outage.
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 2000;

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

/**
 * Ten seconds of silence is enough for the kernel to start probing. Without
 * this a connection whose peer disappeared without closing stays "open"
 * indefinitely, and every command written to it waits forever.
 */
const DEFAULT_KEEP_ALIVE_MS = 10000;

const DEFAULT_MAX_RETRIES_PER_REQUEST = 2;

/**
 * Connection settings for the Valkey client, replacing the library's own
 * defaults.
 *
 * The library builds its client from `VALKEY_HOST`/`VALKEY_PORT` and nothing
 * else, leaving every timeout at the driver default of "wait forever". That
 * is what turned a cache that stopped answering on 2026-08-30 into a
 * 68-minute outage: the session check on the request path never returned, so
 * every request died in the auth guard before it reached a controller and
 * before the logging interceptor, and therefore without leaving a single
 * line in the log. The values below make that failure loud and bounded.
 */
@Injectable()
export class ValkeyConfig extends BaseConfig implements ValkeySettings {
  @IsString()
  public readonly host = this.asString('VALKEY_HOST') ?? '127.0.0.1';

  @IsInt()
  @IsPositive()
  public readonly port = this.asNumber('VALKEY_PORT') ?? 6379;

  @IsInt()
  @Min(0)
  @IsOptional()
  public readonly db = this.asNumber('VALKEY_DB');

  @IsString()
  @IsOptional()
  public readonly password = this.nonEmpty('VALKEY_PASSWORD');

  @IsString()
  public readonly keyPrefix = this.asString('VALKEY_PREFIX') ?? '';

  @IsInt()
  @IsPositive()
  public readonly commandTimeoutMs =
    this.asNumber('VALKEY_COMMAND_TIMEOUT_MS') ?? DEFAULT_COMMAND_TIMEOUT_MS;

  @IsInt()
  @IsPositive()
  public readonly connectTimeoutMs =
    this.asNumber('VALKEY_CONNECT_TIMEOUT_MS') ?? DEFAULT_CONNECT_TIMEOUT_MS;

  @IsInt()
  @Min(0)
  public readonly keepAliveMs = this.asNumber('VALKEY_KEEP_ALIVE_MS')
    ?? DEFAULT_KEEP_ALIVE_MS;

  @IsInt()
  @Min(0)
  public readonly maxRetriesPerRequest =
    this.asNumber('VALKEY_MAX_RETRIES_PER_REQUEST')
      ?? DEFAULT_MAX_RETRIES_PER_REQUEST;

  @IsBoolean()
  public readonly offlineQueue = this.asBoolean('VALKEY_OFFLINE_QUEUE')
    ?? false;
}
