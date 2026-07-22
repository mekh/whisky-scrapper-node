import { applyDecorators } from '@nestjs/common';
import {
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
  ValidationOptions,
} from 'class-validator';

import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH } from '~constants';

export const Username = (
  validationOptions?: ValidationOptions,
): PropertyDecorator =>
  applyDecorators(
    IsString(validationOptions),
    IsNotEmpty(validationOptions),
    MaxLength(USERNAME_MAX_LENGTH, validationOptions),
    MinLength(USERNAME_MIN_LENGTH, validationOptions),
  );
