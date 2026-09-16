import { Injectable } from '@nestjs/common';
import { Transactional } from 'typeorm-transactional';

import {
  DEFAULT_PAGE_OFFSET,
  MESSAGE_DEFAULT_PAGE_LIMIT,
  MESSAGE_MAX_PAGE_LIMIT,
} from '~constants';
import { CoreBaseService } from '~core/_common';
import { MessageKind } from '~enums';
import { NotFoundError } from '~errors';
import type {
  ID,
  Message,
  MessageBroadcastAudience,
  MessageBroadcastInput,
  MessageBroadcastOutcome,
  MessageBroadcastPreview,
  MessageDeliverInput,
  MessageListQuery,
  MessageReadState,
  MessageUnreadCount,
  TypePaginated,
} from '~types';

import { MessageEntity } from './message.entity';
import { MessageRepository } from './message.repository';

/**
 * Persistence-layer public API for the inbox.
 *
 * Every read and every write is scoped to one user, so nothing here can reach
 * another account's messages. Both mutations answer with the new unread count,
 * which is what lets the badge update without a second request.
 */
@Injectable()
export class CoreMessageService extends CoreBaseService<MessageEntity> {
  /**
   * Clamps a requested page size to something the inbox will serve.
   *
   * @param limit - The requested page size, if any.
   * @returns The page size to use.
   */
  private static pageLimit(limit?: number): number {
    if (limit === undefined) {
      return MESSAGE_DEFAULT_PAGE_LIMIT;
    }

    return Math.min(Math.max(limit, 1), MESSAGE_MAX_PAGE_LIMIT);
  }

  public constructor(protected readonly repo: MessageRepository) {
    super(repo);
  }

  /**
   * Reads one page of a user's inbox, unread first and newest first.
   *
   * @param userId - Whose inbox to read.
   * @param query - The requested page.
   * @returns The page in the API's paginated envelope.
   */
  public async listForUser(
    userId: ID,
    query: MessageListQuery,
  ): Promise<TypePaginated<Message>> {
    const limit = CoreMessageService.pageLimit(query.limit);
    const offset = query.offset ?? DEFAULT_PAGE_OFFSET;

    const [data, total] = await Promise.all([
      this.repo.listForUser(userId, limit, offset),
      this.repo.countForUser(userId),
    ]);

    return { data, total, limit, offset };
  }

  /**
   * Delivers one message to a set of users.
   *
   * The message row and its recipient rows are written in one transaction, so
   * a message can never exist with nobody to read it.
   *
   * @param input - What to send and to whom.
   * @returns The new message's id, or null when nobody was addressed.
   */
  @Transactional()
  public async deliver(input: MessageDeliverInput): Promise<ID | null> {
    if (!input.userIds.length) {
      return null;
    }

    const message = await this.repo.save(this.repo.create({
      kind: input.kind,
      payload: input.payload,
      createdByUserId: input.createdByUserId,
    }));

    await this.repo.insertRecipients(message.id, input.userIds);

    return message.id;
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
    const recipients = await this.repo.countAudience(audience);

    return { recipients };
  }

  /**
   * Sends one authored message to everyone an audience resolves to.
   *
   * The audience is resolved through the same predicate the preview counts,
   * so what an admin was shown and what is delivered cannot diverge.
   *
   * @param input - What to send and to whom.
   * @param authorId - The admin sending it, recorded on the message.
   * @returns The created message, how many people received it, and who they
   *   were — the ids are for the caller's event fan-out, not for the wire.
   */
  @Transactional()
  public async broadcast(
    input: MessageBroadcastInput,
    authorId: ID,
  ): Promise<MessageBroadcastOutcome> {
    const userIds = await this.repo.findAudience(input);

    const messageId = await this.deliver({
      kind: MessageKind.ADMIN_BROADCAST,
      payload: {
        subject: input.subject,
        body: input.body,
        subjectEn: input.subjectEn,
        bodyEn: input.bodyEn,
        url: input.url,
      },
      userIds,
      createdByUserId: authorId,
    });

    return { messageId, recipients: userIds.length, userIds };
  }

  /**
   * Counts a user's unread messages.
   *
   * @param userId - Whose unread messages to count.
   * @returns The tally the badge renders.
   */
  public async unreadCount(userId: ID): Promise<MessageUnreadCount> {
    const count = await this.repo.countUnreadForUser(userId);

    return { count };
  }

  /**
   * Marks one of a user's messages read or unread.
   *
   * @param userId - The recipient.
   * @param messageId - The message to change.
   * @param read - True to mark read, false to return it to unread.
   * @returns The message's new state and the user's new unread count.
   * @throws {NotFoundError} When the message is unknown or addressed to
   *   somebody else.
   */
  @Transactional()
  public async setRead(
    userId: ID,
    messageId: ID,
    read: boolean,
  ): Promise<MessageReadState> {
    const readAt = await this.repo.setReadForUser(messageId, userId, read);

    if (readAt === undefined) {
      throw new NotFoundError('Message not found');
    }

    const { count } = await this.unreadCount(userId);

    return { id: messageId, readAt, count };
  }

  /**
   * Marks every unread message of one user read.
   *
   * @param userId - Whose inbox to clear.
   * @returns The user's unread count afterwards, which is always zero.
   */
  @Transactional()
  public async markAllRead(userId: ID): Promise<MessageUnreadCount> {
    await this.repo.markAllReadForUser(userId);

    return this.unreadCount(userId);
  }
}
