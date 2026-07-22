import { Injectable } from '@nestjs/common';
import {
  JwtModuleOptions,
  JwtOptionsFactory,
  JwtVerifyOptions,
} from '@nestjs/jwt';
import { JwtSignOptions } from '@nestjs/jwt/dist/interfaces';
import { IsInt, IsPositive, IsString } from 'class-validator';

import { BaseConfig } from '../base.config';

@Injectable()
export class JwtAccessConfig extends BaseConfig implements JwtOptionsFactory {
  @IsString()
  public readonly secret = this.asString('JWT_ACCESS_SECRET')!;

  @IsInt()
  @IsPositive()
  public readonly expiresIn = this.asNumber('JWT_ACCESS_EXPIRES') ?? 600;

  public signOptions: JwtSignOptions = {
    ...this.expiresIn && { expiresIn: this.expiresIn },
  };

  public verifyOptions: JwtVerifyOptions = {};

  public createJwtOptions(): JwtModuleOptions {
    return {
      secret: this.secret,
      signOptions: this.signOptions,
    };
  }
}
