import { Injectable } from '@nestjs/common';
import {
  IsBoolean,
  IsInt,
  IsPositive,
  IsString,
  Min,
} from 'class-validator';

import { BaseConfig } from '../base.config';

const DEFAULT_VAPID_SUBJECT = 'mailto:admin@localhost';

const DEFAULT_CONCURRENCY = 8;

/**
 * One day. A digest names today's price drops, so a device that stays offline
 * longer than that should receive nothing rather than stale news.
 */
const DEFAULT_TTL_SEC = 86400;

const DEFAULT_LOG_RETENTION_DAYS = 30;

@Injectable()
export class PushConfig extends BaseConfig {
  /**
   * Whether web-push notifications are on at all. Off by default so a deploy
   * without VAPID keys never tries to send anything.
   */
  @IsBoolean()
  public readonly enabled = this.asBoolean('PUSH_ENABLED') ?? false;

  /**
   * VAPID public key, base64url. Handed to the browser as the
   * `applicationServerKey` of a push subscription. Rotating it invalidates
   * every stored subscription.
   */
  @IsString()
  public readonly vapidPublicKey =
    this.asString('PUSH_VAPID_PUBLIC_KEY') ?? '';

  /**
   * VAPID private key, base64url. A secret — never logged, never sent to the
   * client.
   */
  @IsString()
  public readonly vapidPrivateKey =
    this.asString('PUSH_VAPID_PRIVATE_KEY') ?? '';

  /**
   * VAPID contact, a `mailto:` address or an `https://` URL. Push services
   * use it to reach the operator about a misbehaving sender.
   *
   * Read via `nonEmpty`, not `??`: compose declares the variable as
   * `${PUSH_VAPID_SUBJECT:-}`, so in a container the name is always defined
   * and a plain `??` would hand the empty string to the library, which
   * rejects it and silently turns push off.
   */
  @IsString()
  public readonly vapidSubject = this.nonEmpty('PUSH_VAPID_SUBJECT')
    ?? DEFAULT_VAPID_SUBJECT;

  /**
   * How many push sends run at once during a dispatch.
   */
  @IsInt()
  @IsPositive()
  public readonly concurrency = this.asNumber('PUSH_CONCURRENCY')
    ?? DEFAULT_CONCURRENCY;

  /**
   * How long, in seconds, a push service may hold an undelivered message for
   * an offline device.
   */
  @IsInt()
  @Min(0)
  public readonly ttlSec = this.asNumber('PUSH_TTL_SEC') ?? DEFAULT_TTL_SEC;

  /**
   * How many days a `push_digest_log` row is kept before the dispatch pass
   * prunes it. The rows only exist to deduplicate same-day dispatches, so
   * anything older is dead weight.
   */
  @IsInt()
  @IsPositive()
  public readonly logRetentionDays =
    this.asNumber('PUSH_LOG_RETENTION_DAYS') ?? DEFAULT_LOG_RETENTION_DAYS;

  /**
   * Whether the feature can actually send: enabled by config and holding both
   * VAPID keys. The validators above stay permissive on purpose — a missing
   * key must degrade to "push off", not fail the boot.
   */
  public get isUsable(): boolean {
    return this.enabled
      && this.vapidPublicKey.length > 0
      && this.vapidPrivateKey.length > 0;
  }
}
