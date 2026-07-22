import { IsString, MaxLength } from 'class-validator';
import { Column, Entity, Index } from 'typeorm';

import { BRAND_NAME_MAX_LENGTH } from '~constants';
import type { EntityBrand } from '~types';

import { BaseRichEntity } from '../_common';

@Entity('brand')
export class BrandEntity extends BaseRichEntity implements EntityBrand {
  @IsString()
  @MaxLength(BRAND_NAME_MAX_LENGTH)
  @Column({ length: BRAND_NAME_MAX_LENGTH })
  @Index('brand_name_uindex', { unique: true })
  public name!: string;
}
