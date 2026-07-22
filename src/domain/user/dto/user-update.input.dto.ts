import { OmitType, PartialType } from '@nestjs/swagger';

import { UserUpdateInput } from '~types';
import { UserCreateInputDto } from './user-create.input.dto';

export class UserUpdateInputDto extends PartialType(
  OmitType(UserCreateInputDto, ['password']),
) implements UserUpdateInput {}
