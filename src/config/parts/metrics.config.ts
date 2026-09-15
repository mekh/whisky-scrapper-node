import { Injectable } from '@nestjs/common';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

import type { MetricsSettings } from '~types';

import { BaseConfig } from '../base.config';

/**
 * How often the periodic collector refreshes what it owns. A minute is far
 * finer than the things it measures change — a store syncs daily — and it is
 * one existing query per tick.
 */
const DEFAULT_COLLECT_INTERVAL_MS = 60_000;

/**
 * Settings for the Prometheus endpoint and the collectors behind it.
 */
@Injectable()
export class MetricsConfig extends BaseConfig implements MetricsSettings {
  @IsBoolean()
  public readonly enabled = this.asBoolean('METRICS_ENABLED') ?? true;

  @IsBoolean()
  public readonly defaultMetrics = this.asBoolean('METRICS_DEFAULT_METRICS') ??
    true;

  /**
   * Read with `nonEmpty`, not `?? undefined`: compose forwards an omitted
   * host variable as an empty string, and an empty token compared against a
   * header would reject every scrape.
   */
  @IsString()
  @IsOptional()
  public readonly token = this.nonEmpty('METRICS_TOKEN');

  @IsInt()
  @IsPositive()
  public readonly collectIntervalMs =
    this.asNumber('METRICS_COLLECT_INTERVAL_MS')
      ?? DEFAULT_COLLECT_INTERVAL_MS;
}
