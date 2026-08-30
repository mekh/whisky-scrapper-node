import { Injectable } from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Min,
} from 'class-validator';

import { BaseConfig } from '../base.config';

type Loglevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

/**
 * How long the whole handler chain — guards, interceptors, controller and
 * serialization — may take before the request is failed with `503`.
 *
 * Nothing this API serves legitimately takes half a minute; what does take
 * longer is a request stuck on a dependency that will never answer. Failing
 * it loudly beats holding the socket until the proxy gives up, which is what
 * produced a wall of `504`s with nothing in the log to explain them.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

/**
 * Hard deadline on an in-flight request, enforced on its socket. Deliberately
 * above {@link DEFAULT_REQUEST_TIMEOUT_MS} so the interceptor always gets to
 * answer `503` first; this only fires for a request the interceptor never saw
 * — one that stalled in a guard, where Nest runs nothing of ours yet.
 */
const DEFAULT_REQUEST_DEADLINE_MS = 45000;

const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 72000;

@Injectable()
export class AppConfig extends BaseConfig {
  @IsString()
  public readonly appName = this.asString('APP_NAME') ?? 'Whisky Scrapper';

  @IsString()
  @IsOptional()
  public readonly host = this.asString('APP_HOST') ?? '0.0.0.0';

  @IsInt()
  @IsPositive()
  public readonly port = this.asNumber('APP_PORT') ?? 4000;

  @IsBoolean()
  @IsOptional()
  public readonly logging?: boolean = this.asBoolean('APP_LOGGING') ?? true;

  @IsIn(['error', 'warn', 'info', 'debug', 'trace'])
  public readonly logLevel: Loglevel = this
    .asString('APP_LOGLEVEL') as Loglevel | undefined ?? 'info';

  /**
   * Whether to mount Swagger UI (/docs) and the OpenAPI spec (/docs-json).
   * These routes are registered on Fastify outside the global auth guards,
   * so they are unauthenticated when on — keep it off (default) in
   * production and enable it in local/dev only (needed by `pnpm openapi`).
   */
  @IsBoolean()
  public readonly swaggerEnabled: boolean = this.asBoolean('SWAGGER_ENABLED') ??
    false;

  @IsArray()
  @IsString({ each: true })
  public readonly corsOrigins: string[] =
    this.asArray('CORS_ORIGINS')?.map((origin) => origin.trim())
      ?? ['https://whisky.vlm.com.ua'];

  /**
   * Budget for one request inside the application, enforced by
   * `TimeoutInterceptor`. Zero disables it.
   */
  @IsInt()
  @Min(0)
  public readonly requestTimeoutMs = this.asNumber('APP_REQUEST_TIMEOUT_MS')
    ?? DEFAULT_REQUEST_TIMEOUT_MS;

  /**
   * Deadline applied to the socket of a request while it is in flight, and
   * lifted the moment the response is done. Zero disables it.
   *
   * Scoped to in-flight requests rather than set server-wide on purpose: a
   * server-wide socket timeout also reaps *idle* keep-alive connections, and
   * a connection the proxy still believes is pooled turns into a spurious
   * `502` on its next request.
   */
  @IsInt()
  @Min(0)
  public readonly requestDeadlineMs = this.asNumber('APP_REQUEST_DEADLINE_MS')
    ?? DEFAULT_REQUEST_DEADLINE_MS;

  /**
   * How long an idle keep-alive connection is held open. Kept above the
   * reverse proxy's own keep-alive so the proxy, not this server, decides
   * when a pooled connection ends — the other way round races into spurious
   * `502`s.
   */
  @IsInt()
  @IsPositive()
  public readonly keepAliveTimeoutMs =
    this.asNumber('APP_KEEP_ALIVE_TIMEOUT_MS')
      ?? DEFAULT_KEEP_ALIVE_TIMEOUT_MS;

  @IsInt()
  @IsPositive()
  public readonly throttleTtlMs = this.asNumber('THROTTLE_TTL_MS') ?? 60000;

  @IsInt()
  @IsPositive()
  public readonly throttleLimit = this.asNumber('THROTTLE_LIMIT') ?? 60;
}
