import { Injectable } from '@nestjs/common';

import { CoreBaseService } from '~core/_common';
import {
  ID,
  PushDevice,
  PushDropRow,
  PushSubscribeInput,
  PushUserTarget,
} from '~types';

import { PushRepository } from './push.repository';
import { PushSubscriptionEntity } from './push-subscription.entity';

/**
 * Persistence-layer public API for push subscriptions and the digest dedup
 * log. Key material (`p256dh`, `auth`) enters through `subscribe` and leaves
 * only inside send targets — the device listing never carries it.
 */
@Injectable()
export class CorePushService extends CoreBaseService<PushSubscriptionEntity> {
  public constructor(protected readonly repo: PushRepository) {
    super(repo);
  }

  /**
   * Registers or refreshes one browser's subscription for a user.
   *
   * @param userId - The subscription's (possibly new) owner.
   * @param input - The flattened browser subscription.
   * @param userAgent - The subscribing browser's User-Agent, if known.
   * @returns The user's devices after the change, newest first.
   */
  public async subscribe(
    userId: ID,
    input: PushSubscribeInput,
    userAgent: string | null,
  ): Promise<PushDevice[]> {
    await this.repo.upsertSubscription(userId, input, userAgent);

    return this.repo.findDevicesByUserId(userId);
  }

  /**
   * Drops one of the user's subscriptions; an unknown endpoint is a no-op.
   *
   * @param userId - The owning user.
   * @param endpoint - The subscription's push service URL.
   * @returns The user's devices after the change, newest first.
   */
  public async unsubscribe(
    userId: ID,
    endpoint: string,
  ): Promise<PushDevice[]> {
    await this.repo.deleteByEndpoint(userId, endpoint);

    return this.repo.findDevicesByUserId(userId);
  }

  /**
   * Drops dead subscriptions, whoever owns them.
   *
   * @param endpoints - Push service URLs to drop; an empty array is a no-op.
   */
  public async dropDeadEndpoints(endpoints: string[]): Promise<void> {
    await this.repo.deleteByEndpoints(endpoints);
  }

  /**
   * Lists a user's subscribed devices, newest first, without key material.
   *
   * @param userId - Whose devices to list.
   * @returns The devices; empty when the user never subscribed.
   */
  public async findDevicesByUserId(userId: ID): Promise<PushDevice[]> {
    return this.repo.findDevicesByUserId(userId);
  }

  /**
   * Loads the send targets of a set of users in one round trip.
   *
   * @param userIds - Users to load targets for.
   * @returns Every subscription of every listed user.
   */
  public async findTargetsByUserIds(
    userIds: ID[],
  ): Promise<PushUserTarget[]> {
    return this.repo.findTargetsByUserIds(userIds);
  }

  /**
   * Whether any subscription exists at all.
   *
   * @returns True when at least one device is subscribed.
   */
  public async hasAnySubscription(): Promise<boolean> {
    return this.repo.hasAnySubscription();
  }

  /**
   * Stamps the subscriptions a push service just accepted a message for.
   *
   * @param endpoints - Push service URLs to stamp; an empty array is a no-op.
   */
  public async touchSuccess(endpoints: string[]): Promise<void> {
    await this.repo.touchSuccess(endpoints);
  }

  /**
   * Atomically claims the not-yet-announced price drops of one capture day.
   *
   * @param capturedOn - The capture day (`YYYY-MM-DD`) to claim drops for.
   * @param maxGapDays - Oldest allowed age, in days, of the previous snapshot
   *   a drop is measured against.
   * @returns The drops this call claimed; a repeat call returns nothing new.
   */
  public async claimDrops(
    capturedOn: string,
    maxGapDays: number,
  ): Promise<PushDropRow[]> {
    return this.repo.claimDrops(capturedOn, maxGapDays);
  }

  /**
   * Deletes dedup rows older than the retention window.
   *
   * @param before - Exclusive lower bound (`YYYY-MM-DD`).
   */
  public async pruneDigestLog(before: string): Promise<void> {
    await this.repo.pruneDigestLog(before);
  }
}
