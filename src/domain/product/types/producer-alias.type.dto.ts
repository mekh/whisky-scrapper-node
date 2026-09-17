import { IsDate, IsOptional, IsString } from 'class-validator';

import type { ProducerAliasScope } from '~enums';
import type { ID, ProducerAliasRow } from '~types';

export class ProducerAliasType implements ProducerAliasRow {
  @IsString()
  public id!: ID;

  @IsString()
  public key!: string;

  @IsString()
  public scope!: ProducerAliasScope;

  @IsOptional()
  @IsString()
  public note!: string | null;

  @IsDate()
  public createdAt!: Date;
}
