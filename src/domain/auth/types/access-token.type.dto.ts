import { IsNotEmpty, IsString } from 'class-validator';

import type { AuthAccess } from '~types';

export class AccessToken implements AuthAccess {
  @IsString()
  @IsNotEmpty()
  public access!: string;
}
