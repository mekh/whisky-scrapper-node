import { IsDate, IsOptional, IsString, MaxLength } from 'class-validator';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import {
  PUSH_ENDPOINT_MAX_LENGTH,
  PUSH_KEY_MAX_LENGTH,
  PUSH_USER_AGENT_MAX_LENGTH,
} from '~constants';
import { GuidV7Column } from '~decorators/columns';
import type { EntityPushSubscription, EntityUser, ID } from '~types';

import { BaseRichEntity } from '../_common';

/**
 * One browser's push subscription. `endpoint` is unique across users — it
 * identifies the browser installation — so a re-subscribe or an account
 * switch on the same profile is an upsert that reassigns `userId`, never a
 * second row.
 */
@Entity('push_subscription')
@Index('push_subscription_endpoint_uindex', ['endpoint'], { unique: true })
export class PushSubscriptionEntity extends BaseRichEntity
  implements EntityPushSubscription {
  @GuidV7Column()
  @Index('push_subscription_user_idx')
  public userId!: ID;

  @IsString()
  @MaxLength(PUSH_ENDPOINT_MAX_LENGTH)
  @Column({ type: 'text' })
  public endpoint!: string;

  @IsString()
  @MaxLength(PUSH_KEY_MAX_LENGTH)
  @Column({ length: PUSH_KEY_MAX_LENGTH })
  public p256dh!: string;

  @IsString()
  @MaxLength(PUSH_KEY_MAX_LENGTH)
  @Column({ length: PUSH_KEY_MAX_LENGTH })
  public auth!: string;

  @IsString()
  @IsOptional()
  @MaxLength(PUSH_USER_AGENT_MAX_LENGTH)
  @Column({ length: PUSH_USER_AGENT_MAX_LENGTH, nullable: true })
  public userAgent?: string;

  @IsDate()
  @IsOptional()
  @Column({ precision: null, type: 'timestamp', nullable: true })
  public lastSuccessAt?: Date;

  @ManyToOne(
    'UserEntity',
    (user: EntityUser) => user.id,
    { onDelete: 'CASCADE', onUpdate: 'CASCADE' },
  )
  @JoinColumn({
    foreignKeyConstraintName: 'fk_push_subscription_user',
    name: 'userId',
  })
  public user!: EntityUser;
}
