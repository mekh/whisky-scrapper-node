import { Injectable } from '@nestjs/common';
import { IsBoolean, IsInt, IsPositive } from 'class-validator';

import type { WatchdogSettings } from '~types';

import { BaseConfig } from '../base.config';

const DEFAULT_INTERVAL_MS = 10000;

/**
 * A quarter of a second of event-loop delay is already visible to a user and
 * far above anything this process does legitimately, so it is the point at
 * which a heartbeat stops being routine and becomes a warning.
 */
const DEFAULT_LAG_WARN_MS = 250;

const DEFAULT_PING_TIMEOUT_MS = 1000;

/**
 * Settings of the runtime heartbeat.
 *
 * On by default, and deliberately so: the 68-minute outage on 2026-08-30 left
 * **no trace at all** in the application log, because everything that could
 * have written one was stuck behind the same stalled dependency. A heartbeat
 * that only runs when somebody remembered to enable it would have been off
 * that morning too.
 */
@Injectable()
export class WatchdogConfig extends BaseConfig implements WatchdogSettings {
  @IsBoolean()
  public readonly enabled = this.asBoolean('WATCHDOG_ENABLED') ?? true;

  @IsInt()
  @IsPositive()
  public readonly intervalMs = this.asNumber('WATCHDOG_INTERVAL_MS')
    ?? DEFAULT_INTERVAL_MS;

  @IsInt()
  @IsPositive()
  public readonly lagWarnMs = this.asNumber('WATCHDOG_LAG_WARN_MS')
    ?? DEFAULT_LAG_WARN_MS;

  @IsInt()
  @IsPositive()
  public readonly pingTimeoutMs = this.asNumber('WATCHDOG_PING_TIMEOUT_MS')
    ?? DEFAULT_PING_TIMEOUT_MS;
}
