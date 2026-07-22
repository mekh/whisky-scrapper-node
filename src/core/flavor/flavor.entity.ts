import { IsString, MaxLength } from 'class-validator';
import { Column, Entity, Index } from 'typeorm';

import { FLAVOR_NAME_MAX_LENGTH } from '~constants';
import type { EntityFlavor } from '~types';

import { BaseRichEntity } from '../_common';

@Entity('flavor')
export class FlavorEntity extends BaseRichEntity implements EntityFlavor {
  @IsString()
  @MaxLength(FLAVOR_NAME_MAX_LENGTH)
  @Column({ length: FLAVOR_NAME_MAX_LENGTH })
  @Index('flavor_name_uindex', { unique: true })
  public name!: string;
}
