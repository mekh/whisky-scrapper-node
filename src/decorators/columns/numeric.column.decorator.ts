import { Column, ColumnOptions } from 'typeorm';

import { PRICE_PRECISION, PRICE_SCALE } from '~constants';

/**
 * Fixed-point numeric column that surfaces as a JS `number` instead of the
 * string TypeORM returns for `numeric`/`decimal` columns. Defaults to the
 * shared price precision/scale.
 *
 * @param options - Extra column options; `type`/`transformer` are managed here.
 * @returns A property decorator configuring the numeric column.
 */
export const NumericColumn = (
  options?: Omit<ColumnOptions, 'type' | 'transformer'>,
): PropertyDecorator =>
  Column({
    precision: PRICE_PRECISION,
    scale: PRICE_SCALE,
    ...options,
    type: 'numeric',
    transformer: {
      to: (value?: number | null): number | null | undefined => value,
      from: (value?: string | null): number | null | undefined =>
        value === null || value === undefined ? value : parseFloat(value),
    },
  });
