import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import {
  MESSAGE_EVENTS_CHANNEL,
  MESSAGE_STREAM_HEARTBEAT_MS,
} from '~constants';
import { CoreMessageService } from '~core/message';
import { ValkeyPubSubService } from '~lib/valkey';
import type { ID, MessageStreamEvent, Response } from '~types';
import { ErrorUtils } from '~utils';

/**
 * The headers that make a response a stream rather than a document.
 *
 * `X-Accel-Buffering` is for nginx, which otherwise buffers a proxied response
 * and would hold every event until the connection ends; the dedicated
 * `location` block in `infra/nginx/nginx.conf` turns buffering off as well,
 * and this header is the belt to that pair of braces.
 */
const STREAM_HEADERS = {
  'Cache-Control': 'private, no-cache, no-store, no-transform',
  Connection: 'keep-alive',
  'Content-Type': 'text/event-stream; charset=utf-8',
  'X-Accel-Buffering': 'no',
};

/**
 * What a connected stream is: a function that writes one event to it.
 */
type Sink = (event: MessageStreamEvent) => void;

/**
 * Routes inbox events to whichever tabs are parked on *this* replica.
 *
 * The indirection through Valkey is not a scale decision. The API runs several
 * replicas behind HAProxy with no stickiness, so the replica that writes a
 * digest is usually not the one holding the reader's stream — an in-process
 * `Subject` would deliver to roughly one replica in N, and would look perfectly
 * correct in single-instance local development.
 */
@Injectable()
export class MessageStreamService implements OnModuleInit {
  private readonly logger = new Logger(MessageStreamService.name);

  private readonly sinks = new Map<ID, Set<Sink>>();

  public constructor(
    private readonly pubsub: ValkeyPubSubService,
    private readonly messages: CoreMessageService,
  ) {}

  /**
   * Starts listening for events published by any replica, this one included.
   */
  public async onModuleInit(): Promise<void> {
    await this.pubsub.subscribe(MESSAGE_EVENTS_CHANNEL, (_channel, payload) => {
      this.deliver(payload);
    });
  }

  /**
   * Tells every recipient's open tabs that a message arrived.
   *
   * Each user's own unread count is read and published with the event, so a
   * client can update its badge from the event alone. Failures are swallowed:
   * the message is already written, and the client's polling fallback covers
   * an event that never lands.
   *
   * @param messageId - The message that arrived.
   * @param userIds - Who received it.
   */
  public async announce(messageId: ID, userIds: ID[]): Promise<void> {
    for (const userId of userIds) {
      try {
        const { count } = await this.messages.unreadCount(userId);

        await this.publish({ userId, messageId, count });
      } catch (error) {
        this.logger.warn(
          'Could not announce a message to %s: %s',
          userId,
          ErrorUtils.text(error),
        );
      }
    }
  }

  /**
   * Announces one event to every replica.
   *
   * @param event - What happened, and to whom.
   */
  public async publish(event: MessageStreamEvent): Promise<void> {
    await this.pubsub.publish(MESSAGE_EVENTS_CHANNEL, JSON.stringify(event));
  }

  /**
   * Takes over one response and keeps it open as an event stream.
   *
   * The handler returns as soon as this does — the connection lives on
   * `reply.raw` from then on. That is what keeps `TimeoutInterceptor` out of
   * it: the observable it watches completes in milliseconds, while the socket
   * outlives it by however long the reader keeps the tab open.
   *
   * The first thing written is the reader's true unread count, which is what
   * makes a reconnect correct no matter what it missed while it was away —
   * `Last-Event-ID` replay would add nothing, since every event makes the
   * client refetch anyway.
   *
   * @param userId - Whose inbox to stream.
   * @param reply - The response to take over.
   */
  public open(userId: ID, reply: Response): void {
    reply.hijack();
    reply.raw.writeHead(200, STREAM_HEADERS);

    const write = (event: MessageStreamEvent): void => {
      reply.raw.write(`id: ${event.messageId}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const unregister = this.register(userId, write);

    const heartbeat = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, MESSAGE_STREAM_HEARTBEAT_MS);

    reply.raw.on('close', () => {
      clearInterval(heartbeat);
      unregister();
    });

    void this.sendCurrentCount(userId, reply);
  }

  /**
   * Writes the reader's current unread count as the stream's first event.
   *
   * @param userId - Whose count to read.
   * @param reply - The stream to write it to.
   */
  private async sendCurrentCount(userId: ID, reply: Response): Promise<void> {
    try {
      const { count } = await this.messages.unreadCount(userId);

      reply.raw.write(`data: ${JSON.stringify({ userId, count })}\n\n`);
    } catch (error) {
      this.logger.warn(
        'Could not open the inbox stream with a count: %s',
        ErrorUtils.text(error),
      );
    }
  }

  /**
   * Registers one open stream.
   *
   * @param userId - Whose stream it is.
   * @param sink - Writes one event to it.
   * @returns Unregisters the stream; call it when the connection closes.
   */
  public register(userId: ID, sink: Sink): () => void {
    const existing = this.sinks.get(userId);

    if (existing) {
      existing.add(sink);
    } else {
      this.sinks.set(userId, new Set([sink]));
    }

    return () => {
      const sinks = this.sinks.get(userId);

      if (!sinks) {
        return;
      }

      sinks.delete(sink);

      if (!sinks.size) {
        this.sinks.delete(userId);
      }
    };
  }

  /**
   * Hands one published event to this replica's own streams for that user.
   *
   * @param payload - The event as it arrived on the channel.
   */
  private deliver(payload: string): void {
    let event: MessageStreamEvent;

    try {
      event = JSON.parse(payload) as MessageStreamEvent;
    } catch (error) {
      this.logger.warn(
        'Ignoring an unreadable inbox event: %s',
        ErrorUtils.text(error),
      );

      return;
    }

    this.sinks.get(event.userId)?.forEach((sink) => {
      sink(event);
    });
  }
}
