import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Max,
} from 'class-validator';
import { BaseConfig } from '../base.config';

export class DbConfig extends BaseConfig {
  public readonly type = 'postgres';

  public readonly autoLoadEntities = true;

  public readonly keepConnectionAlive = true;

  public readonly poolSize = 10;

  @IsInt()
  @IsPositive()
  public readonly maxQueryExecutionTime = this.asNumber('DB_SLOW_QUERY_MS') ??
    100;

  @IsString()
  public readonly database = this.asString('DB_NAME');

  @IsString()
  public readonly host = this.asString('DB_HOST') ?? 'localhost';

  @IsInt()
  @IsPositive()
  @Max(2 ** 16 - 1)
  @IsOptional()
  public readonly port = this.asNumber('DB_PORT');

  @IsString()
  public readonly username = this.asString('DB_USER');

  @IsString()
  public readonly password = this.asString('DB_PASS');

  @IsBoolean()
  public readonly logging = this.asBoolean('DB_LOGGING') ?? false;

  @IsInt()
  @IsPositive()
  @IsOptional()
  public readonly retryAttempts = this.asNumber('DB_RETRY_ATTEMPTS');

  @IsInt()
  @IsPositive()
  @IsOptional()
  public readonly retryDelay = this.asNumber('DB_RETRY_DELAY');
}
