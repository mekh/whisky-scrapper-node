import { applyDecorators } from '@nestjs/common';
import {
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidationOptions,
} from 'class-validator';

export const Password = (
  validationOptions?: ValidationOptions,
): PropertyDecorator =>
  applyDecorators(
    IsString(validationOptions),
    IsNotEmpty(validationOptions),
    MaxLength(255, validationOptions),
  );
