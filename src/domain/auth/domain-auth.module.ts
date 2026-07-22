import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { ConfigModule, JwtAccessConfig } from '~config';
import { CoreUserModule } from '~core/user';
import { ValkeyModule } from '~lib/valkey';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthSessionService } from './services/auth-session.service';
import { AuthTokenService } from './services/auth-token.service';

@Module({
  imports: [
    ConfigModule,
    CoreUserModule,
    ValkeyModule,
    JwtModule.registerAsync({
      imports: [
        ConfigModule,
      ],
      useExisting: JwtAccessConfig,
    }),
  ],
  controllers: [
    AuthController,
  ],
  providers: [
    AuthService,
    AuthTokenService,
    AuthSessionService,
  ],
  exports: [
    AuthService,
  ],
})
export class DomainAuthModule {}
