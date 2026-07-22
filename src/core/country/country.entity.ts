import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Column, Entity, Index } from 'typeorm';

import {
  COUNTRY_CODE_MAX_LENGTH,
  COUNTRY_ICON_MAX_LENGTH,
  COUNTRY_NAME_MAX_LENGTH,
} from '~constants';
import type { EntityCountry } from '~types';

import { BaseRichEntity } from '../_common';

@Entity('country')
export class CountryEntity extends BaseRichEntity implements EntityCountry {
  @IsString()
  @MaxLength(COUNTRY_CODE_MAX_LENGTH)
  @Column({ length: COUNTRY_CODE_MAX_LENGTH })
  @Index('country_code_uindex', { unique: true })
  public code!: string;

  @IsString()
  @MaxLength(COUNTRY_NAME_MAX_LENGTH)
  @Column({ length: COUNTRY_NAME_MAX_LENGTH })
  public nameUa!: string;

  @IsString()
  @IsOptional()
  @MaxLength(COUNTRY_ICON_MAX_LENGTH)
  @Column({ length: COUNTRY_ICON_MAX_LENGTH, nullable: true })
  public icon?: string;
}
