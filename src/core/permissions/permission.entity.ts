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

  /**
   * Both columns state `varchar` explicitly rather than leaving TypeORM to read
   * the type off reflection metadata. An enum-typed property serializes to
   * `Object` under per-file transpilation (ts-jest with `isolatedModules`), and
   * TypeORM then refuses to build the metadata at all — which is why this
   * entity could not be registered in a Jest-hosted module graph.
   */
  @IsEnum(Resource)
  @Column({ type: 'varchar', length: 32, nullable: false })
  public resource!: Resource;

  @IsEnum(Action)
  @Column({ type: 'varchar', length: 32, nullable: false })
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
