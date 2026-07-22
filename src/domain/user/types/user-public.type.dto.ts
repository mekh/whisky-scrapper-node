import { OmitType } from '@nestjs/swagger';

import { UserType } from './user.type.dto';

export class UserPublicType extends OmitType(
  UserType,
  [
    'password',
  ],
) {}
