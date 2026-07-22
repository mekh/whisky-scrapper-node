import { IsBoolean, IsDate, IsOptional } from 'class-validator';
import { Column, Entity, Index, OneToMany } from 'typeorm';

import { EMAIL_MAX_LENGTH, USERNAME_MAX_LENGTH } from '~constants';
import { PasswordColumn } from '~decorators/columns';
import { Email, Password, Username } from '~decorators/fields';
import { EntityPermission, EntityUser } from '~types';

import { BaseRichEntity } from '../_common';

@Entity('user')
export class UserEntity extends BaseRichEntity implements EntityUser {
  @Username()
  @Column({ length: USERNAME_MAX_LENGTH })
  public name!: string;

  @Email()
  @IsOptional()
  @Column({ length: EMAIL_MAX_LENGTH, nullable: true })
  @Index('user_email_uindex', { unique: true })
  public email?: string;

  @Password()
  @PasswordColumn({ length: 255, nullable: false })
  public password!: string;

  @IsBoolean()
  @Column({ type: 'boolean', default: false })
  public active!: boolean;

  @IsBoolean()
  @Column({ type: 'boolean', default: false })
  public admin!: boolean;

  @IsDate()
  @IsOptional()
  @Column({ type: 'timestamp', precision: null, nullable: true })
  public lastActiveAt?: Date;

  @OneToMany('PermissionEntity', 'user')
  public permissions!: EntityPermission[];
}
