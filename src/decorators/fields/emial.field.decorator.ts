import { applyDecorators } from '@nestjs/common';
import { IsEmail, Length, ValidationOptions } from 'class-validator';

import { EMAIL_MAX_LENGTH, EMAIL_MIN_LENGTH } from '~constants';

export const Email = (
  validationOptions?: ValidationOptions,
): PropertyDecorator =>
  applyDecorators(
    IsEmail({ allow_utf8_local_part: false }, validationOptions),
    Length(EMAIL_MIN_LENGTH, EMAIL_MAX_LENGTH, validationOptions),
  );
