import { applyDecorators } from '@nestjs/common';
import {
  IsArray,
  IsOptional,
  IsUUID,
  ValidationOptions,
} from 'class-validator';

/**
 * A guid-v7 field, or — with `{ each: true }` — an array of them.
 *
 * `validationOptions` must reach `IsUUID`, not just the `IsArray` branch below:
 * without it `each` was silently dropped and the array itself was validated as
 * one uuid, so any list-valued field answered "must be a UUID" whatever it
 * held.
 *
 * @param validationOptions - Standard class-validator options, `each` included.
 * @param options - `nullable` marks the field optional.
 * @returns A property decorator for a uuid-v7 field.
 */
export const GuidV7 = (
  validationOptions?: ValidationOptions,
  options?: { nullable?: boolean },
): PropertyDecorator =>
  applyDecorators(
    IsUUID(7, validationOptions),
    ...validationOptions?.each ? [IsArray()] : [],
    ...options?.nullable ? [IsOptional()] : [],
  );
