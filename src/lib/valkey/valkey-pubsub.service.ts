import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ValkeyClient, ValkeyService } from '@toxicoder/nestjs-valkey';
import type { ValkeyCluster } from '@toxicoder/nestjs-valkey/dist/valkey.interfaces';

import { ErrorUtils } from '~utils';

/**
 * What a subscriber is handed: the channel a message arrived on and its
 * payload, still as text.
 */
type Listener = (channel: string, payload: string) => void;

/**
 * Fan-out across the API's replicas.
 *
 * The one thing to know before using it: a client in subscribe mode cannot
 * issue ordinary commands, so subscribing needs a **second** connection. That
 * connection is duplicated lazily, on the first subscribe, and closed in
 * `onModuleDestroy` — an open client keeps the event loop alive, which is what
 * would stop every standalone script that carries this module from exiting.
 *
 * It fails open, like the cache: a publish that cannot reach Valkey is logged
 * and swallowed rather than failing whatever caused it, because every consumer
 * of this has a slower path that still works.
 */
@Injectable()
export class ValkeyPubSubService implements OnModuleDestroy {
  private readonly logger = new Logger(ValkeyPubSubService.name);

  private readonly listeners = new Map<string, Set<Listener>>();

  private subscriber?: ValkeyClient | ValkeyCluster;

  public constructor(private readonly valkey: ValkeyService) {}

  /**
   * Sends one payload to every replica listening on a channel, this one
   * included.
   *
   * @param channel - The channel to publish on.
   * @param payload - The message body, already serialized.
   */
  public async publish(channel: string, payload: string): Promise<void> {
    try {
      await this.valkey.getClient().publish(channel, payload);
    } catch (error) {
      this.logger.warn(
        'Could not publish on %s: %s',
        channel,
        ErrorUtils.text(error),
      );
    }
  }

  /**
   * Starts delivering a channel's messages to a listener.
   *
   * @param channel - The channel to listen on.
   * @param listener - Called for every message that arrives.
   * @returns Stops this listener, and unsubscribes when it was the last one.
   */
  public async subscribe(
    channel: string,
    listener: Listener,
  ): Promise<() => void> {
    const existing = this.listeners.get(channel);

    if (existing) {
      existing.add(listener);

      return () => this.drop(channel, listener);
    }

    this.listeners.set(channel, new Set([listener]));

    try {
      await this.client().subscribe(channel);
    } catch (error) {
      this.logger.warn(
        'Could not subscribe to %s: %s',
        channel,
        ErrorUtils.text(error),
      );
    }

    return () => this.drop(channel, listener);
  }

  /**
   * Closes the subscriber connection so a process that only borrowed this can
   * exit.
   */
  public onModuleDestroy(): void {
    this.listeners.clear();

    if (!this.subscriber) {
      return;
    }

    try {
      this.subscriber.disconnect();
    } catch (error) {
      this.logger.warn(
        'Subscriber did not close cleanly: %s',
        ErrorUtils.text(error),
      );
    }
  }

  /**
   * The subscriber connection, duplicated on first use.
   *
   * @returns The connection every subscription shares.
   */
  private client(): ValkeyClient | ValkeyCluster {
    if (this.subscriber) {
      return this.subscriber;
    }

    /*
     * `enableOfflineQueue: true` only for this connection, and it is
     * load-bearing. The shared client disables the queue so a request fails
     * fast rather than hanging on a stalled Valkey — but a subscriber issues
     * its `SUBSCRIBE` once, at boot, before the duplicated socket has
     * finished connecting, and with the queue off that command is rejected
     * outright ("Stream isn't writeable"). The subscription then silently
     * never exists, and every event is dropped for the life of the process.
     *
     * The cast narrows the standalone/cluster union this deployment settles
     * one way: `docker-compose.yaml` runs a single Valkey, and the two
     * `duplicate` overloads take different arguments.
     */
    const source = this.valkey.getClient() as ValkeyClient;

    const client = source.duplicate({ enableOfflineQueue: true });

    client.on('message', (channel: string, payload: string) => {
      this.listeners.get(channel)?.forEach((listener) => {
        listener(channel, payload);
      });
    });

    client.on('error', (error: unknown) => {
      this.logger.warn('Subscriber error: %s', ErrorUtils.text(error));
    });

    this.subscriber = client;

    return client;
  }

  /**
   * Removes one listener, unsubscribing once a channel has none left.
   *
   * @param channel - The channel it listened on.
   * @param listener - The listener to remove.
   */
  private drop(channel: string, listener: Listener): void {
    const listeners = this.listeners.get(channel);

    if (!listeners) {
      return;
    }

    listeners.delete(listener);

    if (listeners.size) {
      return;
    }

    this.listeners.delete(channel);

    void this.subscriber?.unsubscribe(channel).catch((error: unknown) => {
      this.logger.warn(
        'Could not unsubscribe from %s: %s',
        channel,
        ErrorUtils.text(error),
      );
    });
  }
}
