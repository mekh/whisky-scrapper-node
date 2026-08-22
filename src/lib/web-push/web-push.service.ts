import { Injectable, Logger } from '@nestjs/common';
import { WebPushError, sendNotification, setVapidDetails } from 'web-push';

import { PushConfig } from '~config';
import { WebPushOutcome, WebPushTarget } from '~types';

const HTTP_NOT_FOUND = 404;

const HTTP_GONE = 410;

const HTTP_PAYLOAD_TOO_LARGE = 413;

const HTTP_TOO_MANY_REQUESTS = 429;

/**
 * The only file that imports the `web-push` package. Wraps VAPID setup and
 * the per-subscription send behind a domain-free outcome union, so nothing
 * outside this folder sees the library's types or its exceptions.
 *
 * Never throws: an unusable configuration degrades to "push off" at boot, and
 * a failed send becomes an outcome the caller counts.
 */
@Injectable()
export class WebPushService {
  private readonly logger = new Logger(WebPushService.name);

  private readonly usable: boolean;

  public constructor(private readonly config: PushConfig) {
    this.usable = config.isUsable && this.applyVapidDetails();

    if (this.usable) {
      this.logger.log('Web push enabled, subject %s', config.vapidSubject);
    } else {
      this.logger.log(
        'Web push disabled: %s',
        config.enabled ? 'VAPID keys missing or invalid' : 'PUSH_ENABLED off',
      );
    }
  }

  /**
   * Whether sends can happen at all: the feature is on and the VAPID keys
   * were accepted by the library.
   */
  public get enabled(): boolean {
    return this.usable;
  }

  /**
   * Sends one payload to one subscription. The payload is encrypted by the
   * library (aes128gcm) for the target's key pair.
   *
   * @param target - The subscription's endpoint and key material.
   * @param payload - The plaintext message, normally a JSON document.
   * @returns The outcome; `gone` means the subscription is dead and should be
   *   deleted, everything but `sent` is only counted.
   */
  public async send(
    target: WebPushTarget,
    payload: string,
  ): Promise<WebPushOutcome> {
    if (!this.usable) {
      return 'failed';
    }

    try {
      await sendNotification(
        {
          endpoint: target.endpoint,
          keys: {
            p256dh: target.p256dh,
            auth: target.auth,
          },
        },
        payload,
        { TTL: this.config.ttlSec },
      );

      return 'sent';
    } catch (error) {
      return this.outcomeOf(error);
    }
  }

  /**
   * Registers the VAPID details with the library, which validates the key
   * material. A rejected key must not fail the boot — it reads as "push off".
   *
   * @returns True when the details were accepted.
   */
  private applyVapidDetails(): boolean {
    try {
      setVapidDetails(
        this.config.vapidSubject,
        this.config.vapidPublicKey,
        this.config.vapidPrivateKey,
      );

      return true;
    } catch (error) {
      this.logger.error('VAPID configuration rejected: %o', error);

      return false;
    }
  }

  /**
   * Maps a send failure to the outcome union, logging the unexpected ones.
   *
   * @param error - Whatever `sendNotification` threw.
   * @returns The outcome the caller acts on.
   */
  private outcomeOf(error: unknown): WebPushOutcome {
    if (error instanceof WebPushError) {
      if (
        error.statusCode === HTTP_NOT_FOUND
        || error.statusCode === HTTP_GONE
      ) {
        return 'gone';
      }

      if (error.statusCode === HTTP_PAYLOAD_TOO_LARGE) {
        this.logger.error('Push payload too large for %s', error.endpoint);

        return 'too-large';
      }

      if (error.statusCode === HTTP_TOO_MANY_REQUESTS) {
        return 'throttled';
      }

      this.logger.warn(
        'Push send failed with %d for %s',
        error.statusCode,
        error.endpoint,
      );

      return 'failed';
    }

    this.logger.error('Push send failed: %o', error);

    return 'failed';
  }
}
