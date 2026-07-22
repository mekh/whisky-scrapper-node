import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsArray, IsOptional, IsString } from 'class-validator';

/**
 * Optional query field that accepts a comma-separated string and normalizes it
 * into a trimmed, non-empty `string[]` (an already-array value is passed
 * through). Use for CSV-style multi-value query parameters.
 *
 * @returns A property decorator for a `string[]` query field.
 */
export const CsvArray = (): PropertyDecorator =>
  applyDecorators(
    IsOptional(),
    IsArray(),
    IsString({ each: true }),
    Transform(({ value }: { value: unknown }): unknown =>
      typeof value === 'string'
        ? value.split(',').map((part) => part.trim()).filter(Boolean)
        : value
    ),
  );
