import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Optional boolean query field. Query-string values arrive as strings, and
 * `@Type(() => Boolean)` would coerce the literal `'false'` to `true`, so the
 * two accepted spellings are mapped explicitly and anything else is left for
 * `@IsBoolean()` to reject.
 *
 * @returns A property decorator for a boolean query field.
 */
export const BoolQuery = (): PropertyDecorator =>
  applyDecorators(
    IsOptional(),
    IsBoolean(),
    Transform(({ value }: { value: unknown }): unknown => {
      if (value === 'true') {
        return true;
      }

      if (value === 'false') {
        return false;
      }

      return value;
    }),
  );
