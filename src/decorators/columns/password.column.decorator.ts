import { Column, ColumnOptions, ValueTransformer } from 'typeorm';

import { Hash } from '~utils';

const getTransformers = (options: ColumnOptions = {}): ValueTransformer[] => {
  return Array.isArray(options.transformer)
    ? options.transformer
    : [options.transformer].filter(Boolean) as ValueTransformer[];
};

export const PasswordColumn = (
  options: ColumnOptions,
): PropertyDecorator => {
  const transformer = getTransformers(options);

  transformer.push({
    to: (pass?: string): string | undefined =>
      pass
        ? Hash.hashSync(pass)
        : pass,
    from: (pass?: string): string | undefined => pass,
  });

  return Column({ ...options, transformer, select: false });
};
