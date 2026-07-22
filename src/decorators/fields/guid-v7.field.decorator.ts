import { applyDecorators } from '@nestjs/common';
import {
  IsArray,
  IsOptional,
  IsUUID,
  ValidationOptions,
} from 'class-validator';

export const GuidV7 = (
  validationOptions?: ValidationOptions,
  options?: { nullable?: boolean },
): PropertyDecorator =>
  applyDecorators(
    IsUUID(7),
    ...validationOptions?.each ? [IsArray()] : [],
    ...options?.nullable ? [IsOptional()] : [],
  );
