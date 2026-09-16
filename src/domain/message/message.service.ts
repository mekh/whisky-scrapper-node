import { Injectable } from '@nestjs/common';

import { CoreMessageService } from '~core/message';
import type {
  ID,
  Message,
  MessageBroadcastAudience,
  MessageBroadcastInput,
  MessageBroadcastPreview,
  MessageBroadcastResult,
  MessageListQuery,
  MessageReadState,
  MessageUnreadCount,
  TypePaginated,
} from '~types';

import { MessageStreamService } from './message-stream.service';

/**
 * Business layer for the inbox. Thin by design: ownership, ordering and the
 * unread tally are all one scoped SQL statement each, and they live in
 * {@link CoreMessageService} where the transaction is.
 */
@Injectable()
export class MessageService {
  public constructor(
    private readonly messages: CoreMessageService,
    private readonly streams: MessageStreamService,
  ) {}

  /**
   * Reads one page of the calling user's inbox.
   *
   * No existence check on the user: the id comes from a verified access token.
   *
   * @param userId - The authenticated user.
   * @param query - The requested page.
   * @returns The page, unread first and newest first.
   */
  public async list(
    userId: ID,
    query: MessageListQuery,
  ): Promise<TypePaginated<Message>> {
    return this.messages.listForUser(userId, query);
  }

  /**
   * Counts the calling user's unread messages.
   *
   * @param userId - The authenticated user.
   * @returns The tally the badge renders.
   */
  public async unreadCount(userId: ID): Promise<MessageUnreadCount> {
    return this.messages.unreadCount(userId);
  }

  /**
   * Marks one of the calling user's messages read or unread.
   *
   * @param userId - The authenticated user.
   * @param messageId - The message to change.
   * @param read - True to mark read, false to return it to unread.
   * @returns The message's new state and the new unread count.
   */
  public async setRead(
    userId: ID,
    messageId: ID,
    read: boolean,
  ): Promise<MessageReadState> {
    return this.messages.setRead(userId, messageId, read);
  }

  /**
   * Counts the users a broadcast would reach, sending nothing.
   *
   * @param audience - How the recipients are chosen.
   * @returns The audience size.
   */
  public async previewBroadcast(
    audience: MessageBroadcastAudience,
  ): Promise<MessageBroadcastPreview> {
    return this.messages.previewBroadcast(audience);
  }

  /**
   * Sends one authored message to everyone an audience resolves to.
   *
   * @param input - What to send and to whom.
   * @param authorId - The admin sending it.
   * @returns The created message and how many people received it.
   */
  public async broadcast(
    input: MessageBroadcastInput,
    authorId: ID,
  ): Promise<MessageBroadcastResult> {
    const { userIds, ...result } = await this.messages.broadcast(
      input,
      authorId,
    );

    if (result.messageId) {
      await this.streams.announce(result.messageId, userIds);
    }

    return result;
  }

  /**
   * Marks every unread message of the calling user read.
   *
   * @param userId - The authenticated user.
   * @returns The unread count afterwards, which is always zero.
   */
  public async markAllRead(userId: ID): Promise<MessageUnreadCount> {
    return this.messages.markAllRead(userId);
  }
}
