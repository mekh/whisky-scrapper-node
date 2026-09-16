import { IsDate, IsOptional } from 'class-validator';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';

import type {
  EntityMessage,
  EntityMessageRecipient,
  EntityUser,
  ID,
} from '~types';

/**
 * One recipient's copy of a message. Composite-keyed like `FavoriteEntity`:
 * the pair is the identity, which is also what makes the broadcast fan-out an
 * idempotent `INSERT … ON CONFLICT DO NOTHING`.
 *
 * `createdAt` deliberately repeats `message.createdAt`, so the inbox can sort
 * and page without joining back to it.
 */
@Entity('message_recipient')
/**
 * The one index both inbox reads go through: `(userId, (readAt IS NULL) DESC,
 * messageId DESC)`. The decorator cannot express the expression term, so the
 * index is created by hand in the migration and kept out of schema management
 * with `synchronize: false`, exactly as `sync_log_running_uindex` is.
 */
@Index('message_recipient_inbox_idx', { synchronize: false })
export class MessageRecipientEntity implements EntityMessageRecipient {
  @PrimaryColumn('uuid')
  public messageId!: ID;

  @PrimaryColumn('uuid')
  public userId!: ID;

  @IsDate()
  @IsOptional()
  @Column({ precision: null, type: 'timestamp', nullable: true })
  public readAt?: Date;

  @IsDate()
  @CreateDateColumn({
    precision: null,
    type: 'timestamp',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP',
  })
  public createdAt!: Date;

  @ManyToOne(
    'MessageEntity',
    (message: EntityMessage) => message.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_message_recipient_message',
    name: 'messageId',
  })
  public message!: EntityMessage;

  @ManyToOne(
    'UserEntity',
    (user: EntityUser) => user.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_message_recipient_user',
    name: 'userId',
  })
  public user!: EntityUser;
}
