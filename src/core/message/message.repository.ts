import { TypeormRepository } from '@toxicoder/nestjs-typeorm-repository';

import { AudienceMode } from '~enums';
import type { ID, Message, MessageBroadcastAudience } from '~types';

import { BaseRepository } from '../_common';
import { MessageEntity } from './message.entity';

/**
 * One page of a user's inbox, unread first and newest first within each half.
 *
 * `messageId DESC` is the newest-first ordering: ids are uuid v7, so they sort
 * by creation time. The two expressions are exactly what
 * `message_recipient_inbox_idx` indexes.
 */
const LIST_SQL = `
  SELECT
    m.id,
    m.kind,
    m.payload,
    r."readAt",
    r."createdAt"
  FROM message_recipient r
  JOIN message m ON m.id = r."messageId"
  WHERE r."userId" = $1
  ORDER BY (r."readAt" IS NULL) DESC, r."messageId" DESC
  LIMIT $2 OFFSET $3
`;

/**
 * How many messages the user holds in total, read and unread alike — the
 * `total` of the paginated envelope.
 */
const COUNT_SQL = `
  SELECT count(*)::int AS count
  FROM message_recipient
  WHERE "userId" = $1
`;

/**
 * The unread tally behind the badge, served by the leading columns of the
 * inbox index.
 */
const COUNT_UNREAD_SQL = `
  SELECT count(*)::int AS count
  FROM message_recipient
  WHERE "userId" = $1 AND "readAt" IS NULL
`;

/**
 * Moves one message between read and unread.
 *
 * `COALESCE` makes marking read idempotent: a second call keeps the instant
 * the message was first read rather than restamping it.
 */
const SET_READ_SQL = `
  UPDATE message_recipient
  SET "readAt" = CASE
    WHEN $3::boolean THEN COALESCE("readAt", CURRENT_TIMESTAMP)
    ELSE NULL
  END
  WHERE "messageId" = $1 AND "userId" = $2
  RETURNING "readAt"
`;

/**
 * Marks every unread message of one user read. The `IS NULL` predicate keeps
 * it from restamping what was already read.
 */
const MARK_ALL_READ_SQL = `
  UPDATE message_recipient
  SET "readAt" = CURRENT_TIMESTAMP
  WHERE "userId" = $1 AND "readAt" IS NULL
`;

/**
 * Delivers one message to many users in a single round trip, the idiom
 * `PreferenceRepository.insertMembership` already uses. `ON CONFLICT DO
 * NOTHING` makes a retried fan-out harmless.
 */
const INSERT_RECIPIENTS_SQL = `
  INSERT INTO message_recipient ("messageId", "userId")
  SELECT $1, value FROM unnest($2::uuid[]) AS t(value)
  ON CONFLICT ("messageId", "userId") DO NOTHING
`;

/**
 * Who a broadcast reaches, as one predicate both the preview and the send read.
 *
 * Two implementations of this rule is exactly the defect that would let an
 * admin preview one audience and mail another, so there is one — parameterized
 * by mode, with the date bounds open-ended on either side by construction.
 *
 * Inactive accounts are excluded: they cannot sign in, so a message to one is
 * a row nobody will ever read.
 */
const AUDIENCE_PREDICATE = `
  u.active
  AND (
    $1 = '${AudienceMode.ALL}'
    OR ($1 = '${AudienceMode.EXPLICIT_IDS}' AND u.id = ANY($2::uuid[]))
    OR (
      $1 = '${AudienceMode.REGISTRATION_DATE}'
      AND ($3::timestamp IS NULL OR u."createdAt" >= $3::timestamp)
      AND ($4::timestamp IS NULL OR u."createdAt" < $4::timestamp)
    )
  )
`;

/**
 * How many people an audience resolves to, sending nothing.
 */
const AUDIENCE_COUNT_SQL = `
  SELECT count(*)::int AS count FROM "user" u WHERE ${AUDIENCE_PREDICATE}
`;

/**
 * The audience itself, for the fan-out.
 */
const AUDIENCE_IDS_SQL = `
  SELECT u.id FROM "user" u WHERE ${AUDIENCE_PREDICATE} ORDER BY u.id
`;

/**
 * A `count(*)::int` row, as every counting query here returns it.
 */
interface CountRow {
  count: number;
}

/**
 * A `RETURNING "readAt"` row.
 */
interface ReadAtRow {
  readAt: Date | null;
}

/**
 * What TypeORM hands back for an `UPDATE` or a `DELETE`: the returned rows and
 * the affected count, rather than the bare row array every other command
 * yields. Reading such a result as an array of rows silently sees the row
 * array as its first "row".
 */
type UpdateResult<T> = [T[], number];

/**
 * Owns `message` and `message_recipient`.
 *
 * Every read and every write is scoped by `userId`, so a message addressed to
 * somebody else simply matches no row — which is what lets the service answer
 * 404 without leaking that it exists.
 */
@TypeormRepository(MessageEntity)
export class MessageRepository extends BaseRepository<MessageEntity> {
  /**
   * Binds an audience to the four parameters both audience statements take.
   *
   * @param audience - How the recipients are chosen.
   * @returns The bound parameters, in the statements' order.
   */
  private static audienceParams(
    audience: MessageBroadcastAudience,
  ): [AudienceMode, ID[], string | null, string | null] {
    return [
      audience.audience,
      audience.userIds ?? [],
      audience.registeredFrom ?? null,
      audience.registeredTo ?? null,
    ];
  }

  /**
   * Reads one page of a user's inbox.
   *
   * @param userId - Whose inbox to read.
   * @param limit - Page size.
   * @param offset - How many rows to skip.
   * @returns The page's messages, unread first and newest first.
   */
  public async listForUser(
    userId: ID,
    limit: number,
    offset: number,
  ): Promise<Message[]> {
    return await this.query(LIST_SQL, [userId, limit, offset]) as Message[];
  }

  /**
   * Counts every message addressed to a user.
   *
   * @param userId - Whose messages to count.
   * @returns The total, for the paginated envelope.
   */
  public async countForUser(userId: ID): Promise<number> {
    const rows = await this.query(COUNT_SQL, [userId]) as CountRow[];

    return rows[0]?.count ?? 0;
  }

  /**
   * Counts a user's unread messages.
   *
   * @param userId - Whose unread messages to count.
   * @returns The tally the badge renders.
   */
  public async countUnreadForUser(userId: ID): Promise<number> {
    const rows = await this.query(COUNT_UNREAD_SQL, [userId]) as CountRow[];

    return rows[0]?.count ?? 0;
  }

  /**
   * Marks one of a user's messages read or unread.
   *
   * @param messageId - The message to change.
   * @param userId - Its recipient; a mismatch matches no row.
   * @param read - True to mark read, false to return it to unread.
   * @returns The new read timestamp, or undefined when the pair matched none.
   */
  public async setReadForUser(
    messageId: ID,
    userId: ID,
    read: boolean,
  ): Promise<Date | null | undefined> {
    const [rows] = await this.query(
      SET_READ_SQL,
      [messageId, userId, read],
    ) as UpdateResult<ReadAtRow>;

    const row = rows[0];

    return row ? row.readAt : undefined;
  }

  /**
   * Marks every unread message of one user read.
   *
   * @param userId - Whose inbox to clear.
   * @returns How many messages changed.
   */
  public async markAllReadForUser(userId: ID): Promise<number> {
    const [, affected] = await this.query(
      MARK_ALL_READ_SQL,
      [userId],
    ) as UpdateResult<unknown>;

    return affected;
  }

  /**
   * Counts the users a broadcast audience resolves to.
   *
   * @param audience - How the recipients are chosen.
   * @returns How many active users match.
   */
  public async countAudience(
    audience: MessageBroadcastAudience,
  ): Promise<number> {
    const rows = await this.query(
      AUDIENCE_COUNT_SQL,
      MessageRepository.audienceParams(audience),
    ) as CountRow[];

    return rows[0]?.count ?? 0;
  }

  /**
   * Resolves a broadcast audience to the ids it reaches.
   *
   * @param audience - How the recipients are chosen.
   * @returns The matching users' ids.
   */
  public async findAudience(
    audience: MessageBroadcastAudience,
  ): Promise<ID[]> {
    const rows = await this.query(
      AUDIENCE_IDS_SQL,
      MessageRepository.audienceParams(audience),
    ) as { id: ID }[];

    return rows.map((row) => row.id);
  }

  /**
   * Delivers one message to a set of users.
   *
   * @param messageId - The message to deliver.
   * @param userIds - Its recipients; duplicates and re-runs are ignored.
   */
  public async insertRecipients(
    messageId: ID,
    userIds: ID[],
  ): Promise<void> {
    if (!userIds.length) {
      return;
    }

    await this.query(INSERT_RECIPIENTS_SQL, [messageId, userIds]);
  }
}
