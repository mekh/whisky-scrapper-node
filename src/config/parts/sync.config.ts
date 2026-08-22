import { Injectable } from '@nestjs/common';
import { IsBoolean, IsInt, IsPositive, IsString, Min } from 'class-validator';

import { BaseConfig } from '../base.config';

const DEFAULT_CRON_EXPRESSION = '0 12 * * *';

const DEFAULT_TIMEZONE = 'Europe/Kyiv';

const DEFAULT_MAX_PARALLEL_TRACKS = 4;

/**
 * Raised from 15 minutes on 2026-08-22, for `goodwine`: its catalogue is 61
 * pages and its politeness delay is 8-15 s, so the listing walk alone is 8-15
 * minutes and an unlucky run did not fit at all. A run that overruns is
 * abandoned having written nothing, which made the tightest store the one that
 * lost a whole scrape to jitter.
 */
const DEFAULT_STORE_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * The browser tier is an order of magnitude slower: `rozetka` renders ~38 pages
 * in a fresh browser context each, at a 10-20 s politeness delay, so a full
 * pass takes ~20 minutes.
 */
const DEFAULT_BROWSER_STORE_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * How much of a store's budget is held back from the optional passes (detail
 * enrichment and the LLM passes), so a run that spent it all on detail pages
 * or on the model still has time to write what it collected.
 */
const DEFAULT_LLM_DEADLINE_MARGIN_MS = 2 * 60 * 1000;

const DEFAULT_LOG_DIR = './log';

const DEFAULT_LOG_RETENTION_DAYS = 30;

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

  /**
   * The same budget for a store that scrapes through a headless browser
   * (`store_config.needsBrowser`), which is far slower than any HTTP store and
   * would otherwise never finish inside `storeTimeoutMs`.
   */
  @IsInt()
  @IsPositive()
  public readonly browserStoreTimeoutMs =
    this.asNumber('SYNC_BROWSER_STORE_TIMEOUT_MS')
      ?? DEFAULT_BROWSER_STORE_TIMEOUT_MS;

  /**
   * How long before the store's budget expires the optional passes — detail
   * enrichment and the LLM passes — must stop. They only fill secondary
   * fields, so when time runs short they are cut off and the run persists
   * what it has, instead of the whole sync failing on a timeout with the
   * catalogue already scraped.
   */
  @IsInt()
  @IsPositive()
  public readonly llmDeadlineMarginMs =
    this.asNumber('SYNC_LLM_DEADLINE_MARGIN_MS')
      ?? DEFAULT_LLM_DEADLINE_MARGIN_MS;

  /**
   * Directory the per-sync log files are written to, relative to the process
   * working directory unless absolute. An empty value disables file logging
   * altogether — the runs still log to stdout, they just leave no file.
   */
  @IsString()
  public readonly logDir = this.asString('SYNC_LOG_DIR') ?? DEFAULT_LOG_DIR;

  /**
   * How many days a log file is kept before the retention sweep deletes it.
   * `0` keeps every file forever.
   */
  @IsInt()
  @Min(0)
  public readonly logRetentionDays = this.asNumber('SYNC_LOG_RETENTION_DAYS')
    ?? DEFAULT_LOG_RETENTION_DAYS;
}
