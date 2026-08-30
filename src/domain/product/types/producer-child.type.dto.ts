import { IsInt, IsString } from 'class-validator';

import type { KbStatus, PeatProfile, ProducerKind } from '~enums';
import type { ID, ProducerChildRow } from '~types';

export class ProducerChildType implements ProducerChildRow {
  @IsString()
  public id!: ID;

  @IsString()
  public slug!: string;

  @IsString()
  public name!: string;

  @IsString()
  public kind!: ProducerKind;

  @IsString()
  public peatProfile!: PeatProfile;

  @IsString()
  public status!: KbStatus;

  @IsInt()
  public productCount!: number;
}
