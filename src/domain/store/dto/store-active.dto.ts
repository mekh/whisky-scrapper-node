import { IsBoolean } from 'class-validator';

import { StoreActiveInput } from '~types';

export class StoreActiveDto implements StoreActiveInput {
  @IsBoolean()
  public active!: boolean;
}
