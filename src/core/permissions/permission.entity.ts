import { IsEnum } from 'class-validator';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { GuidV7Column } from '~decorators/columns';
import { Action, Resource } from '~enums';
import type { EntityPermission, EntityUser, ID } from '~types';

import { BaseRichEntity } from '../_common';

@Entity('permission')
@Index('permission_user_resource_action_uindex', [
  'userId',
  'resource',
  'action',
], { unique: true })
export class PermissionEntity extends BaseRichEntity
  implements EntityPermission {
  @GuidV7Column()
  public userId!: ID;

  @IsEnum(Resource)
  @Column({ length: 32, nullable: false })
  public resource!: Resource;

  @IsEnum(Action)
  @Column({ length: 32, nullable: false })
  public action!: Action;

  @ManyToOne('UserEntity', 'permissions', {
    eager: true,
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    foreignKeyConstraintName: 'fk_permission_user',
    name: 'userId',
  })
  public user!: EntityUser;
}
