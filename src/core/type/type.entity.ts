import { IsString, MaxLength } from 'class-validator';
import { Column, Entity, Index } from 'typeorm';

import { WHISKY_TYPE_NAME_MAX_LENGTH } from '~constants';
import type { EntityType } from '~types';

import { BaseRichEntity } from '../_common';

@Entity('type')
export class TypeEntity extends BaseRichEntity implements EntityType {
  @IsString()
  @MaxLength(WHISKY_TYPE_NAME_MAX_LENGTH)
  @Column({ length: WHISKY_TYPE_NAME_MAX_LENGTH })
  @Index('type_name_uindex', { unique: true })
  public name!: string;
}
