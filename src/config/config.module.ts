import { Module } from '@nestjs/common';

import { AppConfig } from './parts/app.config';
import { AuthConfig } from './parts/auth.config';
import { CurrencyConfig } from './parts/currency.config';
import { DbConfig } from './parts/db.config';
import { JwtAccessConfig } from './parts/jwt-access.config';
import { LoggerConfig } from './parts/logger.config';
import { PushConfig } from './parts/push.config';
import { RateLimitConfig } from './parts/rate-limit.config';
import { ScrapeConfig } from './parts/scrape.config';
import { SyncConfig } from './parts/sync.config';
import { ValidationConfig } from './parts/validation.config';
import { ValkeyConfig } from './parts/valkey.config';
import { WatchdogConfig } from './parts/watchdog.config';

const providers = [
  AppConfig,
  AuthConfig,
  CurrencyConfig,
  DbConfig,
  JwtAccessConfig,
  LoggerConfig,
  PushConfig,
  RateLimitConfig,
  ScrapeConfig,
  SyncConfig,
  ValidationConfig,
  ValkeyConfig,
  WatchdogConfig,
];

@Module({
  providers,
  exports: providers,
})
export class ConfigModule {}
