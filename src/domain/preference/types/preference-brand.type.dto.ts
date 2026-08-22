import { IsString } from 'class-validator';

import type { PreferenceBrand } from '~types';

export class PreferenceBrandType implements PreferenceBrand {
  @IsString()
  public name!: string;

  @IsString()
  public addedOn!: string;
}
