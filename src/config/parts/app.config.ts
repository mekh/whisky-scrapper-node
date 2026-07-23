import { Injectable } from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

import { BaseConfig } from '../base.config';

type Loglevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

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
  public readonly swaggerEnabled: boolean =
    this.asBoolean('SWAGGER_ENABLED') ?? false;
}
