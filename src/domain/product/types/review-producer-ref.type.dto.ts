import { IsEnum, IsString } from 'class-validator';

import { KbStatus, ProducerKind } from '~enums';
import type { ID, ReviewProducerRef } from '~types';

export class ReviewProducerRefType implements ReviewProducerRef {
  @IsString()
  public id!: ID;

  @IsString()
  public slug!: string;

  @IsString()
  public name!: string;

  @IsEnum(ProducerKind)
  public kind!: ProducerKind;

  @IsEnum(KbStatus)
  public status!: KbStatus;
}
