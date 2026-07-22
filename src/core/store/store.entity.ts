import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { Column, Entity, Index } from 'typeorm';

import {
  BASE_URL_MAX_LENGTH,
  COLOR_MAX_LENGTH,
  STORE_NAME_MAX_LENGTH,
  STORE_SLUG_MAX_LENGTH,
} from '~constants';
import type { EntityStore } from '~types';

import { BaseRichEntity } from '../_common';

@Entity('store')
export class StoreEntity extends BaseRichEntity implements EntityStore {
  @IsString()
  @MaxLength(STORE_SLUG_MAX_LENGTH)
  @Column({ length: STORE_SLUG_MAX_LENGTH })
  @Index('store_slug_uindex', { unique: true })
  public slug!: string;

  @IsString()
  @MaxLength(STORE_NAME_MAX_LENGTH)
  @Column({ length: STORE_NAME_MAX_LENGTH })
  public name!: string;

  @IsString()
  @MaxLength(BASE_URL_MAX_LENGTH)
  @Column({ length: BASE_URL_MAX_LENGTH })
  public baseUrl!: string;

  @IsString()
  @IsOptional()
  @MaxLength(COLOR_MAX_LENGTH)
  @Column({ length: COLOR_MAX_LENGTH, nullable: true })
  public color?: string;

  @IsBoolean()
  @Column({ type: 'boolean', default: true })
  public active!: boolean;
}
