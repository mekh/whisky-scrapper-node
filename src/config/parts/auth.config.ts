import { Injectable } from '@nestjs/common';

import { IsInt, IsPositive } from 'class-validator';

import { BaseConfig } from '../base.config';

const DEFAULT_EXPIRE = 7 * 24 * 60 * 60;

@Injectable()
export class AuthConfig extends BaseConfig {
  @IsInt()
  @IsPositive()
  public readonly refreshExpiresInSec = this.asNumber(
    'REFRESH_EXPIRES_SEC',
  ) ?? DEFAULT_EXPIRE;
}
