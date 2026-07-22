import { IsOptional } from 'class-validator';

import { Password } from '~decorators/fields';
import { UserChangePasswordInput } from '~types';

export class UserChangePasswordInputDto implements UserChangePasswordInput {
  @IsOptional()
  @Password()
  public oldPassword?: string;

  @Password()
  public newPassword!: string;
}
