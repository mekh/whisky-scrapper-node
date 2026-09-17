import { IsString } from 'class-validator';

import type { ProducerOwnerRow } from '~types';

export class ProducerOwnerType implements ProducerOwnerRow {
  @IsString()
  public name!: string;
}
