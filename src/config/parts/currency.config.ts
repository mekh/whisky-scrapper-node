import { Injectable } from '@nestjs/common';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsPositive,
  IsString,
} from 'class-validator';

import { CurrencyConfigShape } from '~types';

import { BaseConfig } from '../base.config';

const DEFAULT_NBU_BASE_URL = 'https://bank.gov.ua';

const DEFAULT_NBU_TIMEOUT_MS = 30 * 1000;

const DEFAULT_NBU_RETRIES = 3;

const DEFAULT_RATE_CODES = ['USD', 'EUR'];

/**
 * The NBU sets the rate of business day D on business day D-1 and publishes it
 * after 15:30 Kyiv time — verified against the API, whose `calcdate` shows
 * Monday's rate calculated on the preceding Friday. Running after that cutoff
 * therefore leaves the table holding the *next* business day's rate, so a run
 * that fails costs nothing: tomorrow is already stored.
 *
 * The exact hour is not load-bearing, though. Each run re-fetches a trailing
 * window and the write is an upsert, so any run repairs whatever earlier runs
 * missed — which is what makes this safe to change per environment.
 */
const DEFAULT_CRON_EXPRESSION = '30 16 * * *';

const DEFAULT_TIMEZONE = 'Europe/Kyiv';

const DEFAULT_SYNC_WINDOW_DAYS = 7;

@Injectable()
export class CurrencyConfig extends BaseConfig implements CurrencyConfigShape {
  /**
   * Origin of the NBU open-data API. Configurable so a test environment can
   * point the sync at a stub instead of the bank.
   */
  @IsString()
  public readonly nbuBaseUrl = this.nonEmpty('NBU_BASE_URL')
    ?? DEFAULT_NBU_BASE_URL;

  /**
   * Budget for one request to the NBU. Every wait on anything external is
   * bounded here — an unbounded one turns the bank's bad minute into a stalled
   * sync run.
   */
  @IsInt()
  @IsPositive()
  public readonly nbuTimeoutMs = this.asNumber('NBU_TIMEOUT_MS')
    ?? DEFAULT_NBU_TIMEOUT_MS;

  /**
   * How many times a failed request is retried before the chunk is abandoned.
   */
  @IsInt()
  @IsPositive()
  public readonly nbuRetries = this.asNumber('NBU_RETRIES')
    ?? DEFAULT_NBU_RETRIES;

  /**
   * Currencies whose rates are fetched. The hryvnia is deliberately absent:
   * it is the base, so there is no rate of it against itself to store.
   */
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  public readonly rateCodes = this.asArray('CURRENCY_RATE_CODES')
    ?.map((code) => code.trim().toUpperCase())
    .filter(Boolean)
    ?? DEFAULT_RATE_CODES;

  /**
   * Whether the daily rate schedule is armed.
   *
   * On by default, unlike `SYNC_CRON_ENABLED`. The asymmetry is deliberate: a
   * scrape that starts on its own is a surprise worth opting into, whereas a
   * rates table that quietly stops updating produces *wrong money* on every
   * screen that converts, and the job is one small request a day to a
   * government open-data API.
   */
  @IsBoolean()
  public readonly cronEnabled = this.asBoolean('CURRENCY_RATE_CRON_ENABLED')
    ?? true;

  /**
   * Cron expression for the daily sync, in `timezone`.
   */
  @IsString()
  public readonly cronExpression =
    this.nonEmpty('CURRENCY_RATE_CRON_EXPRESSION')
      ?? DEFAULT_CRON_EXPRESSION;

  /**
   * IANA timezone the cron expression is evaluated in.
   */
  @IsString()
  public readonly timezone = this.nonEmpty('CURRENCY_RATE_TIMEZONE')
    ?? DEFAULT_TIMEZONE;

  /**
   * How many trailing days a scheduled run re-fetches, today included.
   *
   * More than one on purpose: re-reading a week costs a single request and
   * means a run missed to a restart, a deploy or an outage heals itself at the
   * next tick instead of leaving a permanent hole in the series.
   */
  @IsInt()
  @IsPositive()
  public readonly syncWindowDays =
    this.asNumber('CURRENCY_RATE_SYNC_WINDOW_DAYS')
      ?? DEFAULT_SYNC_WINDOW_DAYS;
}
