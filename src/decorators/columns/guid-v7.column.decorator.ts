import { applyDecorators } from '@nestjs/common';
import { Column, ColumnOptions } from 'typeorm';

import { GuidV7 } from '../fields';

export const GuidV7Column = (
  options?: Omit<ColumnOptions, 'type' | 'default'>,
  autoGenerate = false,
): PropertyDecorator =>
  applyDecorators(
    GuidV7({}, { nullable: options?.nullable }),
    Column({
      ...options,
      type: 'uuid',
      ...autoGenerate ? { default: () => 'uuidv7()' } : {},
    }),
  );
