import { IsEnum, IsObject } from 'class-validator';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { GuidV7Column } from '~decorators/columns';
import { MessageKind } from '~enums';
import type { EntityMessage, EntityUser, ID, MessagePayload } from '~types';

import { BaseRichEntity } from '../_common';

/**
 * One announcement. A broadcast is one of these rows fanned out to many
 * `message_recipient` rows; a discount digest is personalized, so it is one
 * row per recipient — the schema does not need to know the difference.
 *
 * `kind` is a plain `varchar` with no Postgres enum and no `CHECK`, like
 * `product.reviewStatus` and for the same reason: a fourth kind then costs no
 * migration. `MessageKind` is enforced in TypeScript instead.
 */
@Entity('message')
@Index('message_kind_created_idx', ['kind', 'createdAt'])
export class MessageEntity extends BaseRichEntity implements EntityMessage {
  /**
   * States `varchar` explicitly rather than leaving TypeORM to read the type
   * off reflection metadata, the `PermissionEntity` workaround: an enum-typed
   * property serializes to `Object` under per-file transpilation (ts-jest),
   * and TypeORM then refuses to build the metadata at all.
   */
  @IsEnum(MessageKind)
  @Column({ type: 'varchar', length: 24 })
  public kind!: MessageKind;

  @IsObject()
  @Column({ type: 'jsonb', default: () => "'{}'" })
  public payload!: MessagePayload;

  @GuidV7Column({ nullable: true })
  public createdByUserId?: ID;

  @ManyToOne(
    'UserEntity',
    (user: EntityUser) => user.id,
    { onDelete: 'SET NULL', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_message_created_by_user',
    name: 'createdByUserId',
  })
  public createdByUser?: EntityUser;
}
