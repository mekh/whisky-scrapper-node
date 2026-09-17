import { IsOptional, IsString } from 'class-validator';

import type { KbStatus, ProducerKind } from '~enums';
import type { ID, ProducerOptionRow } from '~types';

export class ProducerOptionType implements ProducerOptionRow {
  @IsString()
  public id!: ID;

  @IsString()
  public slug!: string;

  @IsString()
  public name!: string;

  @IsString()
  public kind!: ProducerKind;

  @IsString()
  public status!: KbStatus;

  @IsOptional()
  @IsString()
  public countryIcon!: string | null;
}
