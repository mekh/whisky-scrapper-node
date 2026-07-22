import { PickType } from '@nestjs/swagger';

import { Password } from '~decorators/fields';
import { UserCreateInput } from '~types';

import { UserType } from '../types';

export class UserCreateInputDto extends PickType(
  UserType,
  [
    'name',
    'email',
    'active',
  ],
) implements UserCreateInput {
  @Password()
  public password!: string;
}
