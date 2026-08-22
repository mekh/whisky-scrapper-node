import { applyDecorators } from '@nestjs/common';
import { IsOptional, IsString, Matches } from 'class-validator';

/**
 * Query field holding a bare calendar day as `YYYY-MM-DD`. Deliberately
 * stricter than `@IsDateString()`, which accepts any ISO-8601 value — a full
 * timestamp like `2026-08-21T22:00:00Z` names an ambiguous day depending on
 * the timezone it is read in, so only the ten-character date form passes.
 *
 * @param optional - When true, the field may be absent.
 * @returns A property decorator for a `YYYY-MM-DD` query field.
 */
export const IsoDate = (optional = false): PropertyDecorator =>
  applyDecorators(
    ...(optional ? [IsOptional()] : []),
    IsString(),
    Matches(/^\d{4}-\d{2}-\d{2}$/, {
      message: '$property must be a YYYY-MM-DD date',
    }),
  );
