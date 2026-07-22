import { ColumnOptions } from 'typeorm';

import { GuidV7Column } from './guid-v7.column.decorator';

export const GuidV7PrimaryGeneratedColumn = (
  options?: Omit<ColumnOptions, 'type' | 'default' | 'primary'>,
): PropertyDecorator =>
  GuidV7Column(
    {
      ...options,
      primary: true,
    },
    true,
  );
