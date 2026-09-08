import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches } from 'class-validator';

/**
 * Query field naming a currency by its ISO 4217 alphabetic code.
 *
 * The value is upper-cased before validation, because a client reading a code
 * out of a URL it built itself is entitled to send `usd`: the lookup is
 * case-insensitive everywhere else in this feature (`CoreCurrencyService`
 * folds the code before resolving it), and rejecting the lower-case spelling
 * here alone would be an inconsistency with no upside.
 *
 * @param optional - When true, the field may be absent.
 * @returns A property decorator for an ISO 4217 code query field.
 */
export const CurrencyCode = (optional = false): PropertyDecorator =>
  applyDecorators(
    ...(optional ? [IsOptional()] : []),
    IsString(),
    Matches(/^[A-Z]{3}$/, {
      message: '$property must be a three-letter ISO 4217 code',
    }),
    Transform(({ value }: { value: unknown }): unknown =>
      typeof value === 'string' ? value.trim().toUpperCase() : value
    ),
  );
