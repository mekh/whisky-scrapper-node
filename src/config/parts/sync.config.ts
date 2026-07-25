import { Injectable } from '@nestjs/common';
import { IsBoolean, IsInt, IsPositive, IsString } from 'class-validator';

import { BaseConfig } from '../base.config';

const DEFAULT_CRON_EXPRESSION = '0 12 * * *';

const DEFAULT_TIMEZONE = 'Europe/Kyiv';

const DEFAULT_MAX_PARALLEL_TRACKS = 4;

const DEFAULT_STORE_TIMEOUT_MS = 15 * 60 * 1000;

@Injectable()
export class SyncConfig extends BaseConfig {
  /**
   * Whether the internal daily scheduler is armed. Off by default so a deploy
   * never starts scraping on its own; the schedule is enabled per environment.
   */
  @IsBoolean()
  public readonly cronEnabled = this.asBoolean('SYNC_CRON_ENABLED') ?? false;

  /**
   * Cron expression for the daily full sync, in `timezone`.
   */
  @IsString()
  public readonly cronExpression = this.asString('SYNC_CRON_EXPRESSION')
    ?? DEFAULT_CRON_EXPRESSION;

  /**
   * IANA timezone the cron expression is evaluated in.
   */
  @IsString()
  public readonly timezone = this.asString('SYNC_TIMEZONE') ?? DEFAULT_TIMEZONE;

  /**
   * How many concurrency tracks (a group, or a single group-less store) a full
   * sync runs at once. Stores inside one track always run sequentially.
   */
  @IsInt()
  @IsPositive()
  public readonly maxParallelTracks = this.asNumber('SYNC_MAX_PARALLEL_TRACKS')
    ?? DEFAULT_MAX_PARALLEL_TRACKS;

  /**
   * Wall-clock budget for one store's collection. When it elapses the run is
   * recorded as failed and its lock released.
   */
  @IsInt()
  @IsPositive()
  public readonly storeTimeoutMs = this.asNumber('SYNC_STORE_TIMEOUT_MS')
    ?? DEFAULT_STORE_TIMEOUT_MS;
}
