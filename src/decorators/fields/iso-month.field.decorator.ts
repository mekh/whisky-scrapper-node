import { applyDecorators } from '@nestjs/common';
import { IsOptional, IsString, Matches } from 'class-validator';

/**
 * Query field holding a bare calendar month as `YYYY-MM`, the sibling of
 * {@link IsoDate}. The collection's timeline is bucketed by month or year and
 * its range picker offers nothing finer, so a day component would be data the
 * endpoint has to discard — and discarding it silently is how an off-by-one
 * month gets shipped.
 *
 * @param optional - When true, the field may be absent.
 * @returns A property decorator for a `YYYY-MM` query field.
 */
export const IsoMonth = (optional = false): PropertyDecorator =>
  applyDecorators(
    ...(optional ? [IsOptional()] : []),
    IsString(),
    Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
      message: '$property must be a YYYY-MM month',
    }),
  );
