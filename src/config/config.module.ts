import { Module } from '@nestjs/common';

import { AppConfig } from './parts/app.config';
import { AuthConfig } from './parts/auth.config';
import { DbConfig } from './parts/db.config';
import { JwtAccessConfig } from './parts/jwt-access.config';
import { LoggerConfig } from './parts/logger.config';
import { ValidationConfig } from './parts/validation.config';

const providers = [
  AppConfig,
  AuthConfig,
  DbConfig,
  JwtAccessConfig,
  LoggerConfig,
  ValidationConfig,
];

@Module({
  providers,
  exports: providers,
})
export class ConfigModule {}
