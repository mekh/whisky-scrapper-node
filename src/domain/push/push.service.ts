import { Injectable } from '@nestjs/common';

import { PushConfig } from '~config';
import { PUSH_TEST_BODY, PUSH_TEST_TITLE, PUSH_TEST_URL } from '~constants';
import { CorePushService } from '~core/push';
import { WebPushService } from '~lib/web-push';
import {
  ID,
  PushClientConfig,
  PushDevices,
  PushDigestPayload,
  PushDispatchReport,
  PushSubscribeInput,
} from '~types';

import { PushDigestService } from './push-digest.service';

/**
 * Business layer for a user's own push subscriptions: the opt-in config the
 * client subscribes with, the device list the settings screen renders, and
 * the test send that proves the whole pipeline end to end.
 */
@Injectable()
export class PushService {
  public constructor(
    private readonly core: CorePushService,
    private readonly digest: PushDigestService,
    private readonly webPush: WebPushService,
    private readonly config: PushConfig,
  ) {}

  /**
   * What the client needs to offer the opt-in. The public key is only handed
   * out while sends can actually happen, so the switch and the key can never
   * disagree.
   *
   * @returns The feature flag and, when on, the VAPID public key.
   */
  public clientConfig(): PushClientConfig {
    const enabled = this.webPush.enabled;

    return {
      enabled,
      publicKey: enabled ? this.config.vapidPublicKey : null,
    };
  }

  /**
   * Lists the user's subscribed devices.
   *
   * @param userId - Whose devices to list.
   * @returns The devices, newest first.
   */
  public async devices(userId: ID): Promise<PushDevices> {
    const devices = await this.core.findDevicesByUserId(userId);

    return { devices, total: devices.length };
  }

  /**
   * Registers or refreshes the calling browser's subscription.
   *
   * @param userId - The subscribing user.
   * @param input - The flattened browser subscription.
   * @param userAgent - The subscribing browser's User-Agent; an empty string
   *   is stored as null.
   * @returns The devices after the change, newest first.
   */
  public async subscribe(
    userId: ID,
    input: PushSubscribeInput,
    userAgent: string,
  ): Promise<PushDevices> {
    const devices = await this.core.subscribe(
      userId,
      input,
      userAgent || null,
    );

    return { devices, total: devices.length };
  }

  /**
   * Drops the calling browser's subscription; an unknown endpoint is a no-op.
   *
   * @param userId - The owning user.
   * @param endpoint - The subscription's push service URL.
   * @returns The devices after the change, newest first.
   */
  public async unsubscribe(
    userId: ID,
    endpoint: string,
  ): Promise<PushDevices> {
    const devices = await this.core.unsubscribe(userId, endpoint);

    return { devices, total: devices.length };
  }

  /**
   * Sends a test notification to every device of the user — the cheapest
   * end-to-end check of keys, encryption, the service worker, and click
   * routing.
   *
   * @param userId - Whose devices to test.
   * @returns A dispatch-shaped report of the send.
   */
  public async sendTest(userId: ID): Promise<PushDispatchReport> {
    const targets = await this.core.findTargetsByUserIds([userId]);

    const payload: PushDigestPayload = {
      title: PUSH_TEST_TITLE,
      body: PUSH_TEST_BODY,
      url: PUSH_TEST_URL,
      count: 0,
    };

    const body = JSON.stringify(payload);
    const stats = await this.digest.broadcast(targets, () => body);

    return {
      capturedOn: new Date().toISOString().slice(0, 10),
      users: targets.length ? 1 : 0,
      items: 0,
      ...stats,
    };
  }
}
