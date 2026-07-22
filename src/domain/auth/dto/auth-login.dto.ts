import { IsNotEmpty, IsString } from 'class-validator';

import { Password } from '~decorators/fields';
import type { AuthCredentials } from '~types';

export class AuthLoginDto implements AuthCredentials {
  @IsString()
  @IsNotEmpty()
  public login!: string;

  @Password()
  public password!: string;
}
